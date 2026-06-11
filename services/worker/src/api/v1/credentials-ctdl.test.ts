import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  buildCredentialsCtdlRouter,
  defaultCredentialsCtdlLookup,
  type CredentialsCtdlLookup,
} from './credentials-ctdl.js';
import type { CtdlAnchor } from '../../ctdl/ctdl-serializer.js';
import { validateCtdlJsonLd } from '../../ctdl/ctdl-validation.js';

const { anchorsQuery, insertAudit, loggerWarn } = vi.hoisted(() => {
  const anchorsQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    single: vi.fn(),
  };
  anchorsQuery.select.mockReturnValue(anchorsQuery);
  anchorsQuery.eq.mockReturnValue(anchorsQuery);
  anchorsQuery.is.mockReturnValue(anchorsQuery);

  return {
    anchorsQuery,
    insertAudit: vi.fn(),
    loggerWarn: vi.fn(),
  };
});

vi.mock('../../utils/db.js', () => ({
  db: {
    from: vi.fn((table: string) => {
      if (table === 'audit_events') return { insert: insertAudit };
      if (table === 'anchors') return anchorsQuery;
      return { select: vi.fn() };
    }),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: loggerWarn, error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  config: { frontendUrl: 'https://app.arkova.ai' },
}));

function anchor(overrides: Partial<CtdlAnchor> = {}): CtdlAnchor {
  return {
    publicId: 'ARK-2026-CTDL-001',
    status: 'SECURED',
    credentialType: 'DEGREE',
    subType: 'bachelor',
    label: 'Bachelor of Science',
    description: 'Public credential description',
    metadata: { fingerprint: 'a'.repeat(64), recipient_email: 'recipient@example.com' },
    createdAt: '2026-05-20T12:00:00.000Z',
    chainTimestamp: '2026-05-20T12:10:00.000Z',
    issuedAt: '2026-05-01T00:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
    revocationReason: null,
    issuer: {
      name: 'Arkova University',
      publicId: 'ORG-ARKOVA-U',
      websiteUrl: 'https://example.edu',
    },
    ...overrides,
  };
}

function buildApp(lookup: CredentialsCtdlLookup) {
  const app = express();
  app.use(express.json());
  app.use('/', buildCredentialsCtdlRouter(lookup));
  return app;
}

describe('GET /credentials/:publicId/ctdl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    anchorsQuery.single.mockReset();
    anchorsQuery.select.mockReturnValue(anchorsQuery);
    anchorsQuery.eq.mockReturnValue(anchorsQuery);
    anchorsQuery.is.mockReturnValue(anchorsQuery);
    insertAudit.mockReturnValue({ error: null });
  });

  it('returns CTDL JSON-LD for a secured credential without auth', async () => {
    const lookup: CredentialsCtdlLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(anchor()),
    };

    const res = await request(buildApp(lookup))
      .get('/ARK-2026-CTDL-001/ctdl')
      .set('X-Request-Id', 'req-ctdl-001');

    expect(res.status).toBe(200);
    expect(res.type).toContain('application/ld+json');
    expect(res.body['@context']).toBe('https://credreg.net/ctdl/schema/context/json');
    expect(res.body['@type']).toBe('ceterms:BachelorDegree');
    expect(res.body).not.toHaveProperty('ceterms:ctid');
    expect(res.body).not.toHaveProperty('ceterms:credentialStatusType');
    expect(res.body).not.toHaveProperty('ceterms:dateEffective');
    expect(res.body['ceterms:identifier']).toEqual({
      'ceterms:identifierType': 'Arkova public ID',
      'ceterms:identifierValue': 'ARK-2026-CTDL-001',
    });
    expect(res.body['ceterms:verificationServiceProfile']['ceterms:verificationService']).toBe(
      'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    );
    expect(validateCtdlJsonLd(res.body)).toEqual({ valid: true, errors: [] });
    expect(JSON.stringify(res.body)).not.toContain('recipient@example.com');
    expect(JSON.stringify(res.body)).not.toContain('fingerprint');

    expect(insertAudit).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'ctdl.requested',
      event_category: 'VERIFICATION',
      target_type: 'credential',
      target_id: 'ARK-2026-CTDL-001',
    }));
    const auditPayload = insertAudit.mock.calls[0][0];
    expect(JSON.parse(auditPayload.details)).toMatchObject({
      outcome: 'published',
      http_status: 200,
      request_id: 'req-ctdl-001',
      credential_status: 'SECURED',
      credential_type: 'DEGREE',
    });
  });

  it('maps CPE credit columns from the default DB lookup into public CTDL ValueProfiles', async () => {
    anchorsQuery.single.mockResolvedValueOnce({
      data: {
        public_id: 'ARK-2026-CPE-001',
        status: 'SECURED',
        credential_type: 'CPE',
        sub_type: 'accounting_cpe',
        label: 'Forensic Accounting Update',
        description: 'NASBA CPE completion.',
        metadata: { recipient_email: 'learner@example.edu', fingerprint: 'a'.repeat(64) },
        cpe_metadata: {
          credit_hours: 8,
          credit_type: 'NASBA CPE',
        },
        cle_metadata: null,
        created_at: '2026-05-20T12:00:00.000Z',
        chain_timestamp: '2026-05-20T12:10:00.000Z',
        issued_at: '2026-05-01T00:00:00.000Z',
        expires_at: null,
        revoked_at: null,
        revocation_reason: null,
        org_id: 'org-1',
        organization: {
          display_name: 'Arkova CPA Institute',
          public_id: 'ORG-CPA',
          website_url: 'https://example.edu/cpe',
          domain: 'example.edu',
        },
      },
      error: null,
    });

    const res = await request(buildApp(defaultCredentialsCtdlLookup)).get('/ARK-2026-CPE-001/ctdl');

    expect(res.status).toBe(200);
    expect(anchorsQuery.select).toHaveBeenCalledWith(expect.stringContaining('cpe_metadata, cle_metadata'));
    expect(res.body['ceterms:requires']).toEqual([{
      '@type': 'ceterms:ConditionProfile',
      'ceterms:name': 'Continuing education credit value',
      'ceterms:creditValue': [{
        '@type': 'ceterms:ValueProfile',
        'schema:value': 8,
        'ceterms:creditUnitType': 'creditUnit:ContactHour',
        'schema:description': 'CPE credit hours',
      }],
    }]);
    expect(res.body).not.toHaveProperty('ceterms:expirationDate');
    expect(validateCtdlJsonLd(res.body)).toEqual({ valid: true, errors: [] });
    expect(JSON.stringify(res.body)).not.toContain('learner@example.edu');
    expect(JSON.stringify(res.body)).not.toContain('fingerprint');
  });

  it('still returns CTDL JSON-LD when audit logging fails', async () => {
    insertAudit.mockRejectedValueOnce(new Error('audit insert unavailable'));
    const lookup: CredentialsCtdlLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(anchor()),
    };

    const res = await request(buildApp(lookup)).get('/ARK-2026-CTDL-001/ctdl');

    expect(res.status).toBe(200);
    expect(res.body['@type']).toBe('ceterms:BachelorDegree');
    await vi.waitFor(() => {
      expect(loggerWarn).toHaveBeenCalledWith(expect.objectContaining({
        public_id: 'ARK-2026-CTDL-001',
        error: 'audit insert unavailable',
      }), 'Failed to write CTDL request audit event');
    });
  });

  it('logs Supabase audit insert errors without blocking the public response', async () => {
    insertAudit.mockResolvedValueOnce({ error: { message: 'audit row rejected' } });
    const lookup: CredentialsCtdlLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(anchor()),
    };

    const res = await request(buildApp(lookup)).get('/ARK-2026-CTDL-001/ctdl');

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(loggerWarn).toHaveBeenCalledWith(expect.objectContaining({
        public_id: 'ARK-2026-CTDL-001',
        error: 'audit row rejected',
      }), 'Failed to write CTDL request audit event');
    });
  });

  it('returns 404 for pending credentials and still audits the request', async () => {
    const lookup: CredentialsCtdlLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(anchor({ status: 'PENDING' })),
    };

    const res = await request(buildApp(lookup)).get('/ARK-2026-CTDL-001/ctdl');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
    const auditPayload = insertAudit.mock.calls[0][0];
    expect(JSON.parse(auditPayload.details)).toMatchObject({
      outcome: 'not_publishable',
      http_status: 404,
      credential_status: 'PENDING',
    });
  });

  it('fails closed without CTDL output when transcript-like free text has low-confidence learner PII', async () => {
    const lookup: CredentialsCtdlLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(anchor({
        credentialType: 'DEGREE',
        subType: 'transcript',
        label: 'Official transcript for Jane Q Student',
        description: 'Transcript record for learner Jane Q Student.',
        metadata: { document_type: 'official transcript' },
      })),
    };

    const res = await request(buildApp(lookup)).get('/ARK-2026-CTDL-001/ctdl');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
    expect(JSON.stringify(res.body)).not.toContain('Jane Q Student');
    const auditPayload = insertAudit.mock.calls[0][0];
    expect(JSON.parse(auditPayload.details)).toMatchObject({
      outcome: 'safety_blocked',
      http_status: 404,
      credential_status: 'SECURED',
      credential_type: 'DEGREE',
    });
  });

  it('fails closed for name-first learner PII in transcript-like output', async () => {
    const lookup: CredentialsCtdlLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(anchor({
        credentialType: 'DEGREE',
        subType: 'transcript',
        label: "Jane Q Student's transcript",
        description: 'Official learner record.',
        metadata: { document_type: 'official transcript' },
      })),
    };

    const res = await request(buildApp(lookup)).get('/ARK-2026-CTDL-001/ctdl');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
    expect(JSON.stringify(res.body)).not.toContain('Jane Q Student');
    const auditPayload = insertAudit.mock.calls[0][0];
    expect(JSON.parse(auditPayload.details)).toMatchObject({
      outcome: 'safety_blocked',
      http_status: 404,
    });
  });

  it('returns 410 with a revoked CTDL body for revoked credentials', async () => {
    const lookup: CredentialsCtdlLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(anchor({
        status: 'REVOKED',
        revokedAt: '2026-05-21T00:00:00.000Z',
        revocationReason: 'Revoked by issuer.',
      })),
    };

    const res = await request(buildApp(lookup)).get('/ARK-2026-CTDL-001/ctdl');

    expect(res.status).toBe(410);
    expect(res.body).not.toHaveProperty('ceterms:credentialStatusType');
    expect(res.body).not.toHaveProperty('ceterms:revocationDate');
    expect(res.body).not.toHaveProperty('ceterms:revocationReason');
    expect(validateCtdlJsonLd(res.body)).toEqual({ valid: true, errors: [] });
    const auditPayload = insertAudit.mock.calls[0][0];
    expect(JSON.parse(auditPayload.details)).toMatchObject({
      outcome: 'revoked',
      http_status: 410,
    });
  });

  it('returns 404 when no credential exists', async () => {
    const lookup: CredentialsCtdlLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(null),
    };

    const res = await request(buildApp(lookup)).get('/ARK-2026-MISSING/ctdl');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
    const auditPayload = insertAudit.mock.calls[0][0];
    expect(JSON.parse(auditPayload.details)).toMatchObject({
      outcome: 'not_found',
      http_status: 404,
    });
  });

  it('rejects malformed public IDs before lookup', async () => {
    const lookup: CredentialsCtdlLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(anchor()),
    };

    const res = await request(buildApp(lookup)).get('/%20bad/ctdl');

    expect(res.status).toBe(400);
    expect(lookup.lookupByPublicId).not.toHaveBeenCalled();
    const auditPayload = insertAudit.mock.calls[0][0];
    expect(JSON.parse(auditPayload.details)).toMatchObject({
      outcome: 'invalid',
      http_status: 400,
    });
  });
});
