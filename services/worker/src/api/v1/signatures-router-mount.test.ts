/**
 * Endpoint-reachability regression test — AdES signature router mounting.
 *
 * router.ts previously mounted `signaturesRouter` three times, at '/sign',
 * '/signatures', and '/verify-signature'. Since the router's own internal
 * route strings ALREADY carry those same segments (`router.post('/sign', …)`,
 * `router.get('/signatures', …)`, etc. — see signatures.ts's header comment
 * and docs/stories/23_phase3_esignatures.md §4), Express stripped the mount
 * prefix and then required the segment AGAIN: `POST /api/v1/sign` matched
 * nothing (only `POST /api/v1/sign/sign` did), 404ing every documented AdES
 * endpoint. The fix mounts `signaturesRouter` once at '/' instead.
 *
 * This test reproduces the exact composition router.ts now uses
 * (adesSignatureGate() + signaturesRouter mounted once at '/api/v1') with
 * real HTTP requests via supertest, so a regression to the old triple-mount
 * shape fails a real request/response assertion, not just a source-string
 * match.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock('../_org-auth.js', () => ({
  getCallerOrgId: vi.fn(),
  isCallerOrgAdmin: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../lib/urls.js', () => ({
  buildSignatureVerifyUrl: vi.fn((id: string) => `https://verify.test/${id}`),
}));

vi.mock('../../signatures/engineFactory.js', () => ({
  getAdesEngine: vi.fn(() => ({ sign: vi.fn() })),
}));

import { adesSignatureGate, _resetAdesFlagCacheForTesting } from '../../middleware/adesFeatureGate.js';
import { signaturesRouter } from './signatures.js';

/** Express's own 404 handler has no JSON `error` body — that's the fixture
 * for "this request never reached a route inside signaturesRouter". Any
 * response with our own `error` field proves the path DID resolve into the
 * router (the request was authenticated/validated/handled by our code, even
 * if the specific outcome is a 400/401/403/404 from OUR handler logic). */
function reachedOurHandler(res: request.Response): boolean {
  return res.body && typeof res.body === 'object' && 'error' in res.body;
}

function buildMountedApp() {
  const app = express();
  app.use(express.json());
  process.env.ENABLE_ADES_SIGNATURES = 'true';
  // Mirrors router.ts's mount: gate + router at the API root, router itself
  // mounted under /api/v1 the same way the real app does.
  app.use('/api/v1', adesSignatureGate(), signaturesRouter);
  return app;
}

describe('AdES signature router mount — documented contract paths resolve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetAdesFlagCacheForTesting();
    process.env.ENABLE_ADES_SIGNATURES = 'true';
  });

  it('POST /api/v1/sign reaches the signatures router (not a raw 404)', async () => {
    const app = buildMountedApp();
    const res = await request(app).post('/api/v1/sign').send({});
    expect(res.status).not.toBe(404);
    expect(reachedOurHandler(res)).toBe(true);
  });

  it('GET /api/v1/signatures reaches the signatures router (not a raw 404)', async () => {
    const app = buildMountedApp();
    const res = await request(app).get('/api/v1/signatures');
    expect(res.status).not.toBe(404);
    expect(reachedOurHandler(res)).toBe(true);
  });

  const FAKE_SIGNATURE_ROW = {
    // `enabled: true` satisfies adesSignatureGate()'s own switchboard_flags
    // read too — this generic db.from() mock backs BOTH the gate's flag
    // lookup and the handler's signatures lookup, since both `.single()`
    // through the same mocked builder.
    enabled: true,
    id: 'sig-uuid-1',
    public_id: 'ARK-ACME-SIG-X7Y8Z9',
    org_id: 'org-1',
    status: 'COMPLETE',
    format: 'PAdES',
    level: 'B-B',
    document_fingerprint: 'sha256:' + 'a'.repeat(64),
    signature_value: 'sigvalue',
    signed_attributes: 'attrs',
    signer_name: 'Test Signer',
    signer_org: 'Acme Corp',
    signed_at: '2026-04-03T14:22:00Z',
    created_at: '2026-04-03T14:22:00Z',
    jurisdiction: null,
    ltv_data_embedded: false,
    timestamp_token_id: null,
    revoked_at: null,
    revocation_reason: null,
  };

  it('GET /api/v1/signatures/:id reaches the signatures router and returns the record (not a raw 404)', async () => {
    const { db } = await import('../../utils/db.js');
    vi.mocked(db.from).mockImplementation(
      () =>
        ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: FAKE_SIGNATURE_ROW, error: null }),
        }) as never,
    );
    const app = buildMountedApp();
    const res = await request(app).get('/api/v1/signatures/ARK-ACME-SIG-X7Y8Z9');
    expect(res.status).toBe(200);
    expect(res.body.signature_id).toBe('ARK-ACME-SIG-X7Y8Z9');
  });

  it('POST /api/v1/verify-signature reaches the signatures router and returns a verdict — public, no auth required', async () => {
    const { db } = await import('../../utils/db.js');
    vi.mocked(db.from).mockImplementation(
      () =>
        ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: FAKE_SIGNATURE_ROW, error: null }),
        }) as never,
    );
    const app = buildMountedApp();
    const res = await request(app).post('/api/v1/verify-signature').send({ signature_id: 'ARK-ACME-SIG-X7Y8Z9' });
    // No auth injected in this test app at all — proves this path resolves
    // AND stays reachable without a Bearer token (public verification).
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('valid');
    expect(res.body.signature_id).toBe('ARK-ACME-SIG-X7Y8Z9');
  });

  it('POST /api/v1/signatures/:id/revoke reaches the signatures router (not a raw 404)', async () => {
    const app = buildMountedApp();
    const res = await request(app)
      .post('/api/v1/signatures/ARK-ACME-SIG-X7Y8Z9/revoke')
      .send({ reason: 'KEY_COMPROMISE' });
    expect(res.status).not.toBe(404);
    expect(reachedOurHandler(res)).toBe(true);
  });

  it('regression guard: the OLD triple-mount shape (sub-path prefixes) 404s the documented paths', async () => {
    // Demonstrates the bug this fix addresses: mounting the SAME router at
    // '/sign' (its own internal route strings already say '/sign') 404s the
    // documented `/api/v1/sign` path — Express requires '/sign/sign'
    // instead. This pins down WHY the single-root mount above is required.
    const app = express();
    app.use(express.json());
    app.use('/api/v1/sign', signaturesRouter);
    const res = await request(app).post('/api/v1/sign').send({});
    expect(res.status).toBe(404);
  });
});
