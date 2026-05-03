import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { resourceDetailsRouter } from './resourceDetails.js';
import { v2ErrorHandler } from './problem.js';

vi.mock('../../utils/db.js', () => {
  const from = vi.fn();
  return { db: { from } };
});

vi.mock('../../config.js', () => ({ config: { nodeEnv: 'test' } }));

vi.mock('../../utils/logger.js', () => {
  const log = vi.fn();
  return { logger: { warn: log, error: log, info: log } };
});

vi.mock('../../middleware/errorSanitizer.js', () => ({
  sanitizeErrorMessage(message: string) {
    return message;
  },
}));

vi.mock('./rateLimit.js', () => ({
  createV2ScopeRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { db } from '../../utils/db.js';

type QueryMethod = 'select' | 'eq' | 'in' | 'is' | 'not' | 'or' | 'order' | 'limit';
type MockQuery = Record<QueryMethod | 'maybeSingle', ReturnType<typeof vi.fn>>;

function buildApp(scopes = ['read:records', 'read:orgs']) {
  const app = express();
  app.use((req, _res, next) => {
    req.apiKey = {
      keyId: 'key-1',
      orgId: 'org-1',
      userId: 'user-1',
      scopes,
      rateLimitTier: 'paid',
      keyPrefix: 'ak_test_',
    };
    next();
  });
  app.use(resourceDetailsRouter);
  app.use(v2ErrorHandler);
  return app;
}

function chainableQuery(): MockQuery {
  const methods: QueryMethod[] = ['select', 'eq', 'in', 'is', 'not', 'or', 'order', 'limit'];
  const chain = Object.fromEntries(
    methods.map(name => [name, vi.fn().mockReturnThis()]),
  ) as MockQuery;
  chain.maybeSingle = vi.fn();
  return chain;
}

function mockQuery(data: Record<string, unknown> | null, error: unknown = null): MockQuery {
  const chain = chainableQuery();
  chain.maybeSingle.mockResolvedValue({ data, error });
  vi.mocked(db.from).mockReturnValue(chain as never);
  return chain;
}

const anchorRow = {
  id: 'anchor-internal-id',
  org_id: 'org-1',
  user_id: 'user-1',
  public_id: 'ARK-DOC-ABC',
  filename: 'Employment Verification.pdf',
  description: 'Verified employment record',
  credential_type: 'PROFESSIONAL',
  sub_type: 'employment_verification',
  status: 'SECURED',
  fingerprint: 'a'.repeat(64),
  created_at: '2026-04-24T12:00:00Z',
  chain_timestamp: null,
  chain_tx_id: 'tx-1',
  issued_at: '2026-04-01',
  expires_at: null,
  metadata: {
    issuer: 'Acme HR',
    source_url: 'https://issuer.example/records/abc',
    source_id: 'abc',
    recipient_email: 'private@example.com',
    org_id: 'org-1',
    secret: 'do-not-return',
  },
};

function expectPublicSafeAnchorDetail(body: unknown) {
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain('anchor-internal-id');
  expect(serialized).not.toContain('org-1');
  expect(serialized).not.toContain('user-1');
  expect(serialized).not.toContain('private@example.com');
  expect(serialized).not.toContain('do-not-return');
}

describe('resourceDetailsRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns API-key organization detail by public_id without internal ids', async () => {
    const chain = mockQuery({
      id: 'org-internal-id',
      public_id: 'org_acme',
      display_name: 'Acme Corp',
      description: 'Verified issuer',
      domain: 'acme.com',
      website_url: 'https://acme.com',
      verification_status: 'VERIFIED',
    });

    const res = await request(buildApp()).get('/organizations/org_acme');

    expect(res.status).toBe(200);
    expect(chain.eq).toHaveBeenCalledWith('id', 'org-1');
    expect(chain.eq).toHaveBeenCalledWith('public_id', 'org_acme');
    expect(res.body).toEqual({
      public_id: 'org_acme',
      display_name: 'Acme Corp',
      description: 'Verified issuer',
      domain: 'acme.com',
      website_url: 'https://acme.com',
      verification_status: 'VERIFIED',
    });
    expect(JSON.stringify(res.body)).not.toContain('org-internal-id');
  });

  it('returns problem+json for invalid organization public ids', async () => {
    const res = await request(buildApp()).get('/organizations/bad!id');

    expect(res.status).toBe(400);
    expect(res.type).toBe('application/problem+json');
    expect(res.body.type).toContain('/validation-error');
  });

  it('returns record details by public_id and strips private metadata', async () => {
    const chain = mockQuery(anchorRow);

    const res = await request(buildApp()).get('/records/ARK-DOC-ABC');

    expect(res.status).toBe(200);
    expect(chain.eq).toHaveBeenCalledWith('public_id', 'ARK-DOC-ABC');
    expect(chain.not).toHaveBeenCalledWith('public_id', 'is', null);
    expect(res.body).toMatchObject({
      type: 'record',
      public_id: 'ARK-DOC-ABC',
      verified: true,
      status: 'ACTIVE',
      title: 'Employment Verification.pdf',
      credential_type: 'PROFESSIONAL',
      fingerprint: 'a'.repeat(64),
      record_uri: 'https://app.arkova.ai/verify/ARK-DOC-ABC',
      metadata: {
        issuer: 'Acme HR',
        source_url: 'https://issuer.example/records/abc',
        source_id: 'abc',
      },
    });
    expectPublicSafeAnchorDetail(res.body);
  });

  it('returns problem+json for invalid record public ids', async () => {
    const res = await request(buildApp()).get('/records/not-public');

    expect(res.status).toBe(400);
    expect(res.type).toBe('application/problem+json');
    expect(res.body.type).toContain('/validation-error');
  });

  it('returns not-found problem for missing records', async () => {
    mockQuery(null);

    const res = await request(buildApp()).get('/records/ARK-DOC-MISSING');

    expect(res.status).toBe(404);
    expect(res.type).toBe('application/problem+json');
    expect(res.body.type).toContain('/not-found');
  });

  it('returns not-found problem for missing organization', async () => {
    mockQuery(null);

    const res = await request(buildApp()).get('/organizations/org_missing');

    expect(res.status).toBe(404);
    expect(res.type).toBe('application/problem+json');
    expect(res.body.type).toContain('/not-found');
  });

  it('returns fingerprint detail with read:records scope', async () => {
    const chain = mockQuery(anchorRow);
    const fingerprint = 'A'.repeat(64);

    const res = await request(buildApp()).get(`/fingerprints/${fingerprint}`);

    expect(res.status).toBe(200);
    expect(chain.eq).toHaveBeenCalledWith('fingerprint', fingerprint.toLowerCase());
    expect(res.body.type).toBe('fingerprint');
    expect(res.body.public_id).toBe('ARK-DOC-ABC');
    expectPublicSafeAnchorDetail(res.body);
  });

  it('returns invalid-scope problem when fingerprint detail lacks read:records', async () => {
    const res = await request(buildApp(['read:search'])).get(`/fingerprints/${'a'.repeat(64)}`);

    expect(res.status).toBe(403);
    expect(res.type).toBe('application/problem+json');
    expect(res.body.detail).toContain('read:records');
  });

  it('returns not-found problem for missing fingerprint', async () => {
    mockQuery(null);

    const res = await request(buildApp()).get(`/fingerprints/${'a'.repeat(64)}`);

    expect(res.status).toBe(404);
    expect(res.type).toBe('application/problem+json');
    expect(res.body.type).toContain('/not-found');
  });

  it('returns document details by public_id', async () => {
    mockQuery(anchorRow);

    const res = await request(buildApp()).get('/documents/ARK-DOC-ABC');

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('document');
    expect(res.body.public_id).toBe('ARK-DOC-ABC');
    expect(res.body.record_uri).toBe('https://app.arkova.ai/verify/ARK-DOC-ABC');
    expectPublicSafeAnchorDetail(res.body);
  });

  it('returns not-found problem for missing document', async () => {
    mockQuery(null);

    const res = await request(buildApp()).get('/documents/ARK-DOC-MISSING');

    expect(res.status).toBe(404);
    expect(res.type).toBe('application/problem+json');
    expect(res.body.type).toContain('/not-found');
  });
});
