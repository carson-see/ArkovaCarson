import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { resourceDetailsRouter } from './resourceDetails.js';
import { v2ErrorHandler } from './problem.js';

vi.mock('../../utils/db.js', () => ({ db: { from: vi.fn() } }));
vi.mock('../../config.js', () => ({ config: { nodeEnv: 'test' } }));
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../middleware/errorSanitizer.js', () => ({ sanitizeErrorMessage: (m: string) => m }));

import { db } from '../../utils/db.js';

const mockSelect = vi.fn().mockReturnThis();
const mockEq = vi.fn().mockReturnThis();
const mockIn = vi.fn().mockReturnThis();
const mockIs = vi.fn().mockReturnThis();
const mockNot = vi.fn().mockReturnThis();
const mockOr = vi.fn().mockReturnThis();
const mockOrder = vi.fn().mockReturnThis();
const mockLimit = vi.fn().mockReturnThis();
const mockMaybeSingle = vi.fn();

function mockQueryResults(results: Array<{ data: Record<string, unknown> | null; error?: unknown }>) {
  for (const result of results) {
    mockMaybeSingle.mockResolvedValueOnce({ data: result.data, error: result.error ?? null });
  }
  vi.mocked(db.from).mockReturnValue({
    select: mockSelect,
    eq: mockEq,
    in: mockIn,
    is: mockIs,
    not: mockNot,
    or: mockOr,
    order: mockOrder,
    limit: mockLimit,
    maybeSingle: mockMaybeSingle,
  } as never);
}

function mockQueryResult(data: Record<string, unknown> | null, error: unknown = null) {
  mockQueryResults([{ data, error }]);
}

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

function anchorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'internal-anchor-id',
    org_id: 'org-1',
    user_id: 'user-1',
    public_id: 'ARK-DOC-ABC',
    fingerprint: 'a'.repeat(64),
    filename: 'Contract.pdf',
    description: 'Signed services agreement',
    credential_type: 'LEGAL',
    sub_type: 'contract',
    status: 'SECURED',
    created_at: '2026-04-24T12:00:00Z',
    issued_at: '2026-04-01',
    expires_at: null,
    chain_tx_id: 'tx-1',
    chain_confirmations: 6,
    compliance_controls: { soc2: true },
    version_number: 2,
    revocation_tx_id: null,
    revocation_block_height: null,
    file_mime: 'application/pdf',
    file_size: 12345,
    organization: { display_name: 'Acme Corp' },
    parent: { public_id: 'ARK-DOC-PARENT' },
    ...overrides,
  };
}

describe('resourceDetailsRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns organization detail scoped to the API key org without internal ids', async () => {
    mockQueryResult({
      id: 'org-internal-id',
      public_id: 'org_acme',
      display_name: 'Acme Corp',
      description: 'Verified healthcare org',
      domain: 'acme.com',
      website_url: 'https://acme.com',
      verification_status: 'VERIFIED',
      industry_tag: 'healthcare',
      org_type: 'employer',
      location: 'Detroit, MI',
      logo_url: 'https://cdn.example.com/logo.png',
    });

    const res = await request(buildApp()).get('/organizations/org_acme');

    expect(res.status).toBe(200);
    expect(mockSelect).toHaveBeenCalledWith('public_id, display_name, description, domain, website_url, verification_status, industry_tag, org_type, location, logo_url');
    expect(mockEq).toHaveBeenCalledWith('id', 'org-1');
    expect(mockEq).toHaveBeenCalledWith('public_id', 'org_acme');
    expect(res.body).toMatchObject({
      public_id: 'org_acme',
      display_name: 'Acme Corp',
      industry_tag: 'healthcare',
    });
    expect(JSON.stringify(res.body)).not.toContain('org-internal-id');
  });

  it('returns record detail without leaking anchor, user, or org ids', async () => {
    mockQueryResult(anchorRow());

    const res = await request(buildApp()).get('/records/ARK-DOC-ABC');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      public_id: 'ARK-DOC-ABC',
      verified: true,
      status: 'ACTIVE',
      fingerprint: 'a'.repeat(64),
      title: 'Contract.pdf',
      issuer_name: 'Acme Corp',
      parent_public_id: 'ARK-DOC-PARENT',
      record_uri: 'https://app.arkova.ai/verify/ARK-DOC-ABC',
    });
    expect(res.body).not.toHaveProperty('id');
    expect(res.body).not.toHaveProperty('org_id');
    expect(res.body).not.toHaveProperty('user_id');
    expect(JSON.stringify(res.body)).not.toContain('internal-anchor-id');
    expect(mockOr).toHaveBeenCalledWith('status.eq.SECURED,org_id.eq.org-1');
  });

  it('returns document detail with document metadata fields', async () => {
    mockQueryResult(anchorRow());

    const res = await request(buildApp()).get('/documents/ARK-DOC-ABC');

    expect(res.status).toBe(200);
    expect(res.body.file_mime).toBe('application/pdf');
    expect(res.body.file_size).toBe(12345);
    expect(res.body.public_id).toBe('ARK-DOC-ABC');
    expect(mockOr).toHaveBeenCalledWith('status.eq.SECURED,org_id.eq.org-1');
  });

  it('returns public secured fingerprint detail before same-org pending rows', async () => {
    const fingerprint = 'b'.repeat(64);
    mockQueryResult(anchorRow({ fingerprint, public_id: 'ARK-DOC-FP', status: 'SECURED' }));

    const res = await request(buildApp()).get(`/fingerprints/${fingerprint.toUpperCase()}`);

    expect(res.status).toBe(200);
    expect(mockEq).toHaveBeenCalledWith('fingerprint', fingerprint);
    expect(mockEq).toHaveBeenCalledWith('status', 'SECURED');
    expect(mockNot).toHaveBeenCalledWith('public_id', 'is', null);
    expect(mockIn).not.toHaveBeenCalledWith('status', ['SECURED', 'SUBMITTED', 'PENDING']);
    expect(mockOr).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({
      verified: true,
      status: 'ACTIVE',
      fingerprint,
      public_id: 'ARK-DOC-FP',
    });
  });

  it('falls back to same-org pending fingerprint detail when no public secured row exists', async () => {
    const fingerprint = 'c'.repeat(64);
    mockQueryResults([
      { data: null },
      { data: anchorRow({ fingerprint, public_id: 'ARK-DOC-FP-PENDING', status: 'PENDING' }) },
    ]);

    const res = await request(buildApp()).get(`/fingerprints/${fingerprint}`);

    expect(res.status).toBe(200);
    expect(mockIn).toHaveBeenCalledWith('status', ['SECURED', 'SUBMITTED', 'PENDING']);
    expect(mockOr).toHaveBeenCalledWith('status.eq.SECURED,org_id.eq.org-1');
    expect(res.body).toMatchObject({
      verified: false,
      status: 'PENDING',
      fingerprint,
      public_id: 'ARK-DOC-FP-PENDING',
    });
  });

  it('returns problem+json for missing public records', async () => {
    mockQueryResult(null);

    const res = await request(buildApp()).get('/records/ARK-DOC-MISSING');

    expect(res.status).toBe(404);
    expect(res.type).toBe('application/problem+json');
    expect(res.body.type).toContain('/not-found');
  });

  it('returns problem+json for invalid public ids', async () => {
    const res = await request(buildApp()).get('/records/not-a-public-id');

    expect(res.status).toBe(400);
    expect(res.type).toBe('application/problem+json');
    expect(res.body.type).toContain('/validation-error');
  });

  it('returns invalid-scope problem when detail scope is missing', async () => {
    const res = await request(buildApp(['read:search'])).get('/documents/ARK-DOC-ABC');

    expect(res.status).toBe(403);
    expect(res.type).toBe('application/problem+json');
    expect(res.body.type).toContain('/invalid-scope');
  });
});
