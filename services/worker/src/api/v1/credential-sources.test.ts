import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { credentialSourcesRouter } from './credential-sources.js';

const {
  mockFrom,
  mockProfileSingle,
  mockAnchorsMaybeSingle,
  mockAnchorInsert,
  mockAnchorInsertSingle,
  mockAnchorUpdate,
  mockAnchorUpdateIs,
  mockAnchorUpdateMaybeSingle,
  mockRecipientInsert,
  mockAuditInsert,
  mockDeductOrgCredit,
} = vi.hoisted(() => {
  const mockProfileSingle = vi.fn();
  const mockAnchorsMaybeSingle = vi.fn();
  const mockAnchorInsertSingle = vi.fn();
  const mockAnchorInsert = vi.fn();
  const mockAnchorUpdate = vi.fn();
  const mockAnchorUpdateIs = vi.fn();
  const mockAnchorUpdateMaybeSingle = vi.fn();
  const mockRecipientInsert = vi.fn();
  const mockAuditInsert = vi.fn();
  const mockDeductOrgCredit = vi.fn();

  function chain(overrides: Record<string, unknown> = {}) {
    const builder: Record<string, unknown> = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      is: vi.fn(() => builder),
      order: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      maybeSingle: mockAnchorsMaybeSingle,
      single: mockProfileSingle,
      ...overrides,
    };
    return builder;
  }

  const mockFrom = vi.fn((table: string) => {
    if (table === 'profiles') {
      return chain({ single: mockProfileSingle });
    }
    if (table === 'anchors') {
      const selectChain = chain({ maybeSingle: mockAnchorsMaybeSingle });
      const updateChain: Record<string, unknown> = {};
      Object.assign(updateChain, {
        eq: vi.fn(() => updateChain),
        is: vi.fn((...args: unknown[]) => {
          mockAnchorUpdateIs(...args);
          return updateChain;
        }),
        select: vi.fn(() => updateChain),
        maybeSingle: mockAnchorUpdateMaybeSingle,
      });
      return {
        select: vi.fn(() => selectChain),
        insert: mockAnchorInsert,
        update: mockAnchorUpdate.mockReturnValue(updateChain),
      };
    }
    if (table === 'anchor_recipients') {
      return { insert: mockRecipientInsert };
    }
    if (table === 'audit_events') {
      return { insert: mockAuditInsert };
    }
    return chain();
  });

  return {
    mockFrom,
    mockProfileSingle,
    mockAnchorsMaybeSingle,
    mockAnchorInsert,
    mockAnchorInsertSingle,
    mockAnchorUpdate,
    mockAnchorUpdateIs,
    mockAnchorUpdateMaybeSingle,
    mockRecipientInsert,
    mockAuditInsert,
    mockDeductOrgCredit,
  };
});

vi.mock('../../utils/db.js', () => ({
  db: { from: mockFrom },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../utils/orgCredits.js', () => ({
  deductOrgCredit: mockDeductOrgCredit,
}));

vi.mock('../../webhooks/delivery.js', () => ({
  isPrivateUrlResolved: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../lib/urls.js', () => ({
  buildVerifyUrl: (publicId: string) => `https://app.test/verify/${publicId}`,
}));

function makeApp(userId = 'user-1') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = userId;
    next();
  });
  app.use('/api/v1/credential-sources', credentialSourcesRouter);
  return app;
}

function mockHtmlFetch() {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(
    new Response('<title>Example Credential</title><meta name="issuer" content="Example Issuer">', {
      headers: { 'content-type': 'text/html' },
    }),
  )));
}

describe('credentialSourcesRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHtmlFetch();
    mockProfileSingle.mockResolvedValue({ data: { org_id: 'org-1' }, error: null });
    mockAnchorsMaybeSingle.mockResolvedValue({ data: null, error: null });
    mockDeductOrgCredit.mockResolvedValue({ allowed: true });
    mockAnchorUpdateMaybeSingle.mockResolvedValue({ data: { id: 'anchor-1' }, error: null });
    mockAnchorInsert.mockImplementation((payload: unknown) => ({
      select: vi.fn(() => ({
        single: mockAnchorInsertSingle.mockResolvedValue({
          data: {
            id: 'anchor-1',
            public_id: 'ARK-2026-ABC12345',
            fingerprint: (payload as { fingerprint: string }).fingerprint,
            status: 'PENDING',
            created_at: '2026-05-05T18:50:00Z',
          },
          error: null,
        }),
      })),
    }));
    mockRecipientInsert.mockResolvedValue({ error: null });
    mockAuditInsert.mockResolvedValue({ error: null });
  });

  it('returns a preview for authenticated users', async () => {
    const res = await request(makeApp())
      .post('/api/v1/credential-sources/import-url/preview')
      .send({ source_url: 'https://credentials.example.com/abc?token=secret', credential_type: 'CERTIFICATE' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      normalized_source_url: 'https://credentials.example.com/abc',
      credential_title: 'Example Credential',
      credential_issuer: 'Example Issuer',
      credential_type: 'CERTIFICATE',
      verification_level: 'captured_url',
    });
    expect(res.body.evidence_package_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('creates a pending anchor and links it to the importing user on confirm', async () => {
    const preview = await request(makeApp())
      .post('/api/v1/credential-sources/import-url/preview')
      .send({ source_url: 'https://credentials.example.com/abc', credential_type: 'CERTIFICATE' });

    const res = await request(makeApp())
      .post('/api/v1/credential-sources/import-url/confirm')
      .send({
        source_url: 'https://credentials.example.com/abc',
        credential_type: 'CERTIFICATE',
        expected_source_payload_hash: preview.body.source_payload_hash,
      });

    expect(res.status).toBe(201);
    expect(res.body.duplicate).toBe(false);
    expect(res.body.anchor.public_id).toBe('ARK-2026-ABC12345');
    expect(mockDeductOrgCredit).toHaveBeenCalledWith(expect.anything(), 'org-1', 1, 'anchor.create', 'anchor-1');

    const anchorPayload = mockAnchorInsert.mock.calls[0][0] as {
      fingerprint: string;
      status: string;
      metadata: Record<string, unknown>;
      user_id: string;
      org_id: string;
    };
    expect(anchorPayload).toMatchObject({
      status: 'PENDING',
      user_id: 'user-1',
      org_id: 'org-1',
      credential_type: 'CERTIFICATE',
    });
    expect(anchorPayload.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(anchorPayload.fingerprint).toBe(anchorPayload.metadata.source_anchor_fingerprint);
    expect(anchorPayload.fingerprint).not.toBe(anchorPayload.metadata.evidence_package_hash);
    expect(anchorPayload.metadata).toMatchObject({
      source_url: 'https://credentials.example.com/abc',
      credential_title: 'Example Credential',
      credential_issuer: 'Example Issuer',
      verification_level: 'captured_url',
    });

    const recipientPayload = mockRecipientInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(recipientPayload).toEqual(expect.objectContaining({
      anchor_id: 'anchor-1',
      recipient_user_id: 'user-1',
    }));
    expect(recipientPayload).not.toHaveProperty('claimed_at');

    const auditPayload = mockAuditInsert.mock.calls[0][0] as { details: string };
    const auditDetails = JSON.parse(auditPayload.details) as Record<string, unknown>;
    expect(auditDetails).toMatchObject({
      source_provider: 'generic',
      source_host: 'credentials.example.com',
      evidence_package_hash: expect.any(String),
      source_payload_hash: expect.any(String),
    });
    expect(auditDetails).not.toHaveProperty('source_url');
    expect(auditPayload.details).not.toContain('https://credentials.example.com/abc');
    expect(mockAuditInsert).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'CREDENTIAL_SOURCE_IMPORTED',
      actor_id: 'user-1',
      target_id: 'anchor-1',
    }));
  });

  it('returns the existing anchor when concurrent confirms hit the unique fingerprint guard', async () => {
    mockAnchorsMaybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({
        data: {
          id: 'anchor-existing',
          public_id: 'ARK-2026-EXISTING',
          fingerprint: 'f'.repeat(64),
          status: 'PENDING',
          created_at: '2026-05-05T18:00:00Z',
        },
        error: null,
      });
    mockAnchorInsert.mockImplementation(() => ({
      select: vi.fn(() => ({
        single: mockAnchorInsertSingle.mockResolvedValue({
          data: null,
          error: { code: '23505', message: 'duplicate key value violates unique constraint' },
        }),
      })),
    }));

    const res = await request(makeApp())
      .post('/api/v1/credential-sources/import-url/confirm')
      .send({ source_url: 'https://credentials.example.com/abc', credential_type: 'CERTIFICATE' });

    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(res.body.anchor.public_id).toBe('ARK-2026-EXISTING');
    expect(mockDeductOrgCredit).not.toHaveBeenCalled();
    expect(mockRecipientInsert).toHaveBeenCalledWith(expect.objectContaining({
      anchor_id: 'anchor-existing',
      recipient_user_id: 'user-1',
    }));
    expect(mockAuditInsert).not.toHaveBeenCalled();
  });

  it('rolls back the reserved anchor if the organization lacks credits', async () => {
    mockDeductOrgCredit.mockResolvedValue({
      allowed: false,
      error: 'insufficient_credits',
      balance: 0,
      required: 1,
    });

    const res = await request(makeApp())
      .post('/api/v1/credential-sources/import-url/confirm')
      .send({ source_url: 'https://credentials.example.com/abc', credential_type: 'CERTIFICATE' });

    expect(res.status).toBe(402);
    expect(mockAnchorInsert).toHaveBeenCalledTimes(1);
    expect(mockAnchorUpdate).toHaveBeenCalledWith({ deleted_at: 'now' });
    expect(mockAnchorUpdateIs).toHaveBeenCalledWith('deleted_at', null);
    expect(mockRecipientInsert).not.toHaveBeenCalled();
    expect(mockAuditInsert).not.toHaveBeenCalled();
  });

  it('fails closed if rollback cannot soft-delete a credit-rejected anchor', async () => {
    mockDeductOrgCredit.mockResolvedValue({
      allowed: false,
      error: 'insufficient_credits',
      balance: 0,
      required: 1,
    });
    mockAnchorUpdateMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'update failed' },
    });

    const res = await request(makeApp())
      .post('/api/v1/credential-sources/import-url/confirm')
      .send({ source_url: 'https://credentials.example.com/abc', credential_type: 'CERTIFICATE' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('import_failed');
    expect(mockRecipientInsert).not.toHaveBeenCalled();
    expect(mockAuditInsert).not.toHaveBeenCalled();
  });

  it('rejects confirmation when the source payload changed after preview', async () => {
    const res = await request(makeApp())
      .post('/api/v1/credential-sources/import-url/confirm')
      .send({
        source_url: 'https://credentials.example.com/abc',
        credential_type: 'CERTIFICATE',
        expected_source_payload_hash: '0'.repeat(64),
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('source_changed');
    expect(mockDeductOrgCredit).not.toHaveBeenCalled();
    expect(mockAnchorInsert).not.toHaveBeenCalled();
  });

  it('returns the existing anchor for duplicate source payloads without deducting credit again', async () => {
    mockAnchorsMaybeSingle.mockResolvedValue({
      data: {
        id: 'anchor-existing',
        public_id: 'ARK-2026-EXISTING',
        fingerprint: 'f'.repeat(64),
        status: 'PENDING',
        created_at: '2026-05-05T18:00:00Z',
      },
      error: null,
    });

    const res = await request(makeApp())
      .post('/api/v1/credential-sources/import-url/confirm')
      .send({ source_url: 'https://credentials.example.com/abc', credential_type: 'CERTIFICATE' });

    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(res.body.anchor.public_id).toBe('ARK-2026-EXISTING');
    expect(mockDeductOrgCredit).not.toHaveBeenCalled();
    expect(mockAnchorInsert).not.toHaveBeenCalled();
    expect(mockRecipientInsert).toHaveBeenCalledWith(expect.objectContaining({
      anchor_id: 'anchor-existing',
      recipient_user_id: 'user-1',
    }));
  });

  it('rejects malformed requests before fetching', async () => {
    const res = await request(makeApp())
      .post('/api/v1/credential-sources/import-url/preview')
      .send({ source_url: '' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
