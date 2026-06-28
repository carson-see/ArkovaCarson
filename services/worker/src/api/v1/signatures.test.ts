import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import request from 'supertest';

// ─── Mocks ──────────────────────────────────────────────────────────────
// Owner-inclusive org resolver is the unit under test for the two gates; mock
// it so we can drive the owner / non-member / non-admin cases deterministically.
vi.mock('../_org-auth.js', () => ({
  getCallerOrgId: vi.fn(),
  isCallerOrgAdmin: vi.fn(),
}));

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// `../../lib/urls.js` imports the worker config, which validates required env
// at module load and throws "Invalid worker configuration" in the bare test
// env. The router only uses `buildSignatureVerifyUrl` (success path, not
// exercised by these gate tests) — stub it to decouple from config.
vi.mock('../../lib/urls.js', () => ({
  buildSignatureVerifyUrl: vi.fn((id: string) => `https://verify.test/${id}`),
}));

// The create route reaches the AdES engine factory only AFTER the org gate +
// certificate resolution pass. Our db mock returns no certificate, so the
// engine is never invoked — but mock the factory anyway so an accidental call
// can't hit real PKI/env wiring.
vi.mock('../../signatures/engineFactory.js', () => ({
  getAdesEngine: vi.fn(() => ({ sign: vi.fn() })),
}));

import { signaturesRouter } from './signatures.js';
import { db } from '../../utils/db.js';
import { getCallerOrgId, isCallerOrgAdmin } from '../_org-auth.js';
import { buildApp as buildAppFromRouter, makeBuilder } from './__testHelpers.js';

function buildApp(userId?: string) {
  return buildAppFromRouter(signaturesRouter, '/api/v1', { userId });
}

// ─── Static guard: attestation lookup stays org-scoped (pre-existing) ────
describe('POST /api/v1/sign attestation lookup', () => {
  it('scopes attestation public_id lookup to the signer org', () => {
    const source = readFileSync(new URL('./signatures.ts', import.meta.url), 'utf8');
    const attestationLookup = source.slice(
      source.indexOf('if (body.attestation_id)'),
      source.indexOf('// Generate public ID'),
    );

    expect(attestationLookup).toContain(".from('attestations')");
    expect(attestationLookup).toContain(".eq('public_id', body.attestation_id)");
    expect(attestationLookup).toContain(".eq('attester_org_id', orgId)");
    expect(attestationLookup).not.toContain('public verification endpoint');
  });
});

// ─── Owner-exclusion bug-class regression: GET /api/v1/signatures ────────
// The list gate previously queried org_members directly, which 403s org
// OWNERS (owners are linked via profiles.org_id, not guaranteed an
// org_members row). It must now resolve the org via getCallerOrgId.
describe('GET /api/v1/signatures org resolution', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('requires authentication', async () => {
    const app = buildApp();
    await request(app).get('/api/v1/signatures').expect(401);
  });

  it('lets an org OWNER (no org_members row) list signatures', async () => {
    // getCallerOrgId resolves the owner's org via profiles.org_id.
    vi.mocked(getCallerOrgId).mockResolvedValue('org-owner-1');
    // signatures list query resolves empty.
    vi.mocked(db.from).mockImplementation(
      () => makeBuilder({ data: [] }) as never,
    );

    const app = buildApp('owner-user');
    const res = await request(app).get('/api/v1/signatures').expect(200);
    expect(res.body.signatures).toEqual([]);
    expect(res.body.count).toBe(0);
    // Org was resolved via the owner-inclusive resolver, not org_members.
    expect(vi.mocked(getCallerOrgId)).toHaveBeenCalledWith('owner-user');
  });

  it('scopes the signatures query to the resolved org id', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-owner-1');
    const builder = makeBuilder({ data: [] });
    vi.mocked(db.from).mockImplementation(() => builder as never);

    const app = buildApp('owner-user');
    await request(app).get('/api/v1/signatures').expect(200);
    // The org filter is applied with the resolver's org id (not membership.org_id).
    expect(builder.eq).toHaveBeenCalledWith('org_id', 'org-owner-1');
  });

  it('403s with the original message when the caller has no org', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue(null);

    const app = buildApp('orphan-user');
    const res = await request(app).get('/api/v1/signatures').expect(403);
    expect(res.body.error).toBe('No organization membership found');
  });
});

// ─── Owner-exclusion bug-class regression: POST /api/v1/sign ─────────────
// The create gate previously required an org_members owner/admin row, which
// 403s org OWNERS linked only via profiles.org_id. It must now resolve the
// org via getCallerOrgId and authorize via isCallerOrgAdmin.
describe('POST /api/v1/sign org admin gate', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const validBody = {
    anchor_id: 'ARK-ORG-A1B2C3',
    fingerprint: 'sha256:' + 'a'.repeat(64),
    format: 'PAdES',
    level: 'B-B',
    signer_certificate_id: '11111111-1111-4111-8111-111111111111',
  };

  it('requires authentication', async () => {
    const app = buildApp();
    await request(app).post('/api/v1/sign').send(validBody).expect(401);
  });

  it('lets an org OWNER (admin via resolver) past the gate', async () => {
    // getCallerOrgId resolves the owner's org; isCallerOrgAdmin authorizes.
    vi.mocked(getCallerOrgId).mockResolvedValue('org-owner-1');
    vi.mocked(isCallerOrgAdmin).mockResolvedValue(true);
    // No certificate found → route 404s AFTER the gate. A non-403 here proves
    // the owner is no longer excluded by the org gate.
    vi.mocked(db.from).mockImplementation(
      () => makeBuilder({ singleData: null }) as never,
    );

    const app = buildApp('owner-user');
    const res = await request(app).post('/api/v1/sign').send(validBody);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Signing certificate not found or not active');
    expect(vi.mocked(getCallerOrgId)).toHaveBeenCalledWith('owner-user');
    expect(vi.mocked(isCallerOrgAdmin)).toHaveBeenCalledWith('owner-user', 'org-owner-1');
  });

  it('403s with the original message when the caller has no org', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue(null);

    const app = buildApp('orphan-user');
    const res = await request(app).post('/api/v1/sign').send(validBody).expect(403);
    expect(res.body.error).toBe('Admin or owner role required to create signatures');
    // Short-circuits before the admin check when there is no org.
    expect(vi.mocked(isCallerOrgAdmin)).not.toHaveBeenCalled();
  });

  it('403s with the original message when the caller is a non-admin member', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');
    vi.mocked(isCallerOrgAdmin).mockResolvedValue(false);

    const app = buildApp('member-user');
    const res = await request(app).post('/api/v1/sign').send(validBody).expect(403);
    expect(res.body.error).toBe('Admin or owner role required to create signatures');
  });
});

// ─── Owner-exclusion bug-class regression: POST /api/v1/signatures/:id/revoke ─
// The revoke gate previously queried org_members directly, which 403s org
// OWNERS linked only via profiles.org_id (no guaranteed org_members row). It
// must now authorize via isCallerOrgAdmin, scoped to the signature's OWN org
// (sig.org_id). Unlike create/list, the route already holds the signature row,
// so it does NOT resolve the caller's org via getCallerOrgId.
describe('POST /api/v1/signatures/:id/revoke org admin gate', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const publicId = 'ARK-ORG-SIG-ABCD1234';
  const validBody = { reason: 'SUPERSEDED' };

  // A non-revoked signature row the lookup returns so the flow reaches the admin
  // gate — the route 404s before the gate when the row is missing.
  const sigRow = {
    id: '22222222-2222-4222-8222-222222222222',
    public_id: publicId,
    status: 'PENDING',
    org_id: 'org-owner-1',
  };

  it('requires authentication', async () => {
    const app = buildApp();
    await request(app)
      .post(`/api/v1/signatures/${publicId}/revoke`)
      .send(validBody)
      .expect(401);
  });

  it('lets an org OWNER (admin via resolver) revoke a signature', async () => {
    // isCallerOrgAdmin authorizes the owner against the signature's OWN org.
    // Every db.from() returns a builder whose .single() yields the sig row; the
    // subsequent update + audit insert resolve without error.
    vi.mocked(isCallerOrgAdmin).mockResolvedValue(true);
    vi.mocked(db.from).mockImplementation(
      () => makeBuilder({ singleData: sigRow }) as never,
    );

    const app = buildApp('owner-user');
    const res = await request(app)
      .post(`/api/v1/signatures/${publicId}/revoke`)
      .send(validBody)
      .expect(200);
    expect(res.body.signature_id).toBe(publicId);
    expect(res.body.status).toBe('REVOKED');
    expect(res.body.reason).toBe('SUPERSEDED');
    // Admin check is scoped to the signature's own org id (not a separately
    // resolved caller org) — owners with no org_members row are not excluded.
    expect(vi.mocked(isCallerOrgAdmin)).toHaveBeenCalledWith('owner-user', 'org-owner-1');
  });

  it('404s (before the admin check) when the signature does not exist', async () => {
    // Lookup resolves null → route 404s and never reaches the admin gate.
    vi.mocked(db.from).mockImplementation(
      () => makeBuilder({ singleData: null }) as never,
    );

    const app = buildApp('owner-user');
    const res = await request(app)
      .post(`/api/v1/signatures/${publicId}/revoke`)
      .send(validBody)
      .expect(404);
    expect(res.body.error).toBe('Signature not found');
    expect(vi.mocked(isCallerOrgAdmin)).not.toHaveBeenCalled();
  });

  it('403s with the original message when the caller is a non-admin', async () => {
    vi.mocked(isCallerOrgAdmin).mockResolvedValue(false);
    vi.mocked(db.from).mockImplementation(
      () => makeBuilder({ singleData: { ...sigRow, org_id: 'org-1' } }) as never,
    );

    const app = buildApp('member-user');
    const res = await request(app)
      .post(`/api/v1/signatures/${publicId}/revoke`)
      .send(validBody)
      .expect(403);
    expect(res.body.error).toBe('Admin or owner role required to revoke signatures');
    // Gate is scoped to the signature's own org id.
    expect(vi.mocked(isCallerOrgAdmin)).toHaveBeenCalledWith('member-user', 'org-1');
  });
});
