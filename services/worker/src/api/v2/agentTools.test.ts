import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { agentToolsRouter } from './agentTools.js';
import { v2ErrorHandler } from './problem.js';

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  config: { nodeEnv: 'test' },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../middleware/errorSanitizer.js', () => ({
  sanitizeErrorMessage: (m: string) => m,
}));

import { db } from '../../utils/db.js';

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
  app.use(agentToolsRouter);
  app.use(v2ErrorHandler);
  return app;
}

function mockAnchorLookup(data: Record<string, unknown> | null, error: unknown = null) {
  (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
  });
}

describe('agentToolsRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns problem+json for malformed fingerprints', async () => {
    const res = await request(buildApp()).get('/verify/not-a-hash');

    expect(res.status).toBe(400);
    expect(res.type).toBe('application/problem+json');
    expect(res.body.type).toContain('/validation-error');
  });

  it('verifies a known fingerprint', async () => {
    const fingerprint = 'a'.repeat(64);
    mockAnchorLookup({
      id: 'anchor-1',
      public_id: 'ARK-DOC-ABC',
      fingerprint,
      filename: 'Contract.pdf',
      status: 'SECURED',
      created_at: '2026-04-24T12:00:00Z',
      chain_tx_id: 'tx-1',
    });

    const res = await request(buildApp()).get(`/verify/${fingerprint}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      verified: true,
      status: 'ACTIVE',
      public_id: 'ARK-DOC-ABC',
      network_receipt_id: 'tx-1',
    });
  });

  it('returns invalid-scope problem when read:records is missing', async () => {
    const res = await request(buildApp(['read:search'])).get(`/verify/${'a'.repeat(64)}`);

    expect(res.status).toBe(403);
    expect(res.type).toBe('application/problem+json');
    expect(res.body.type).toContain('/invalid-scope');
  });

  it('returns not-found problem for missing public anchors', async () => {
    (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { error: 'Credential not found' },
      error: null,
    });

    const res = await request(buildApp()).get('/anchors/ARK-DOC-MISSING');

    expect(res.status).toBe(404);
    expect(res.type).toBe('application/problem+json');
    expect(res.body.type).toContain('/not-found');
  });

  it('lists the API key organization context', async () => {
    const select = vi.fn().mockReturnThis();
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select,
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: 'org-1',
          public_id: 'org_acme',
          display_name: 'Acme Corp',
          domain: 'acme.com',
          website_url: 'https://acme.com',
          verification_status: 'VERIFIED',
        },
        error: null,
      }),
    });

    const res = await request(buildApp()).get('/orgs');

    expect(res.status).toBe(200);
    expect(res.body.organizations).toEqual([
      expect.objectContaining({ public_id: 'org_acme' }),
    ]);
    expect(res.body.organizations[0]).not.toHaveProperty('id');
    expect(JSON.stringify(res.body)).not.toContain('org-1');
    expect(select).toHaveBeenCalledWith(
      'public_id, display_name, domain, website_url, verification_status',
    );
  });
});
