/**
 * Signature Compliance API — owner-inclusive org-resolution tests.
 *
 * Regression coverage for the P1 owner-exclusion bug class: the four org-scoped
 * gates on this router previously resolved the caller's org by querying
 * `org_members` directly, which 403s org OWNERS (owners are linked via
 * `profiles.org_id` and are NOT guaranteed an `org_members` row). The fix routes
 * every gate through the canonical, owner-inclusive resolver in `../_org-auth`:
 *   - `getCallerOrgId(userId)`            — resolves `profiles.org_id` (owners).
 *   - `isCallerOrgAdmin(userId, orgId)`   — owner/admin/ORG_ADMIN/platform-admin.
 *
 * These tests MOCK `../_org-auth` so each case drives the resolver decision
 * directly (the helpers' own DB-level behavior is covered by
 * `api/_org-auth.test.ts`). An OWNER is represented by the canonical resolver
 * returning an org id + admin=true WITHOUT any `org_members` row — exactly the
 * case the old `org_members`-only query missed. The signature-compliance
 * generators are mocked: these tests assert the AUTHORIZATION contract, not
 * bundle/report generation.
 *
 * Authorization matrix:
 *   /signatures/:id/audit-proof (membership-only): org id present        → 200
 *                                                  no org (null)         → 403
 *   /signatures/export          (membership-only): org id present        → 200
 *                                                  no org (null)         → 403
 *   /signatures/soc2-evidence   (admin-gated):     org id + admin        → 200
 *                                                  no org / not admin    → 403
 *   /signatures/gdpr-article30  (admin-gated):     same as soc2-evidence
 *   /signatures/eidas-report    (admin-gated):     same as soc2-evidence
 *
 * SECURITY REGRESSION COVERAGE (fix, 2026-07-28): `/signatures/:id/audit-proof`
 * previously had NO org check at all — any authenticated user could pull any
 * other org's signature audit proof. `generateAuditProof` now takes and is
 * scoped by `orgId`; the tests below prove the fix by asserting the resolved
 * org is always forwarded and a caller with no org membership is rejected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Org-auth resolver (the unit under test drives these) ────────────────────
const getCallerOrgId = vi.fn();
const isCallerOrgAdmin = vi.fn();

vi.mock('../_org-auth.js', () => ({
  getCallerOrgId: (...args: unknown[]) => getCallerOrgId(...args),
  isCallerOrgAdmin: (...args: unknown[]) => isCallerOrgAdmin(...args),
}));

// ─── Signature-compliance generators (mocked — authz contract under test) ────
const bulkExportSignatures = vi.fn();
const generateSoc2EvidenceBundle = vi.fn();
const generateGdprArticle30Export = vi.fn();
const generateEidasComplianceReport = vi.fn();
const generateAuditProof = vi.fn();

vi.mock('../../signatures/compliance/auditProofExporter.js', () => ({
  generateAuditProof: (...args: unknown[]) => generateAuditProof(...args),
  bulkExportSignatures: (...args: unknown[]) => bulkExportSignatures(...args),
  generateSoc2EvidenceBundle: (...args: unknown[]) => generateSoc2EvidenceBundle(...args),
  generateGdprArticle30Export: (...args: unknown[]) => generateGdprArticle30Export(...args),
  generateEidasComplianceReport: (...args: unknown[]) => generateEidasComplianceReport(...args),
}));

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { signatureComplianceRouter } from './signatureCompliance.js';

/** Build an app injecting a fixed authenticated user (the org OWNER). */
function buildApp(userId?: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) req.authUserId = userId;
    next();
  });
  app.use('/api/v1', signatureComplianceRouter);
  return app;
}

const FROM = '2026-01-01T00:00:00Z';
const TO = '2026-12-31T00:00:00Z';

/**
 * Default: the caller is an org OWNER. The canonical resolver returns the org id
 * (from profiles.org_id) and reports admin=true — WITHOUT any org_members row.
 * This is precisely the case the old `org_members`-only gate 403'd.
 */
function asOwner() {
  getCallerOrgId.mockResolvedValue('org-owned');
  isCallerOrgAdmin.mockResolvedValue(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  asOwner();
  bulkExportSignatures.mockResolvedValue({
    contentType: 'application/json',
    filename: 'signatures.json',
    data: '[]',
  });
  generateSoc2EvidenceBundle.mockResolvedValue({ bundle: 'soc2' });
  generateGdprArticle30Export.mockResolvedValue({ report: 'gdpr' });
  generateEidasComplianceReport.mockResolvedValue({ report: 'eidas' });
  generateAuditProof.mockResolvedValue({ version: '1.0', credential: {}, compliance: {}, evidence_layers: [], disclaimers: [] });
});

// ─── GET /signatures/:id/audit-proof (membership-only) — cross-tenant fix ────
describe('GET /api/v1/signatures/:id/audit-proof — membership-only, cross-tenant fix', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(buildApp()).get('/api/v1/signatures/sig-1/audit-proof');
    expect(res.status).toBe(401);
    expect(generateAuditProof).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller has no org — the proof generator is never called', async () => {
    getCallerOrgId.mockResolvedValue(null);
    const res = await request(buildApp('stranger')).get('/api/v1/signatures/sig-1/audit-proof');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('No organization membership found');
    expect(generateAuditProof).not.toHaveBeenCalled();
  });

  it('legitimate same-org caller succeeds and the CALLER-resolved org is forwarded, never a client-supplied one', async () => {
    const res = await request(buildApp('owner-1')).get('/api/v1/signatures/sig-1/audit-proof');
    expect(res.status).toBe(200);
    expect(generateAuditProof).toHaveBeenCalledWith('sig-1', 'org-owned');
  });

  it('does NOT require admin for the membership-only audit-proof read', async () => {
    isCallerOrgAdmin.mockResolvedValue(false);
    const res = await request(buildApp('member-1')).get('/api/v1/signatures/sig-1/audit-proof');
    expect(res.status).toBe(200);
    expect(isCallerOrgAdmin).not.toHaveBeenCalled();
  });

  it('returns 404 (not the caller org) when generateAuditProof resolves null — e.g. the signature belongs to another org', async () => {
    // This is the scoped-query behavior in auditProofExporter.ts: a signature
    // that exists but belongs to a DIFFERENT org resolves to null, same as a
    // truly-missing signature — no cross-org existence is ever confirmed.
    generateAuditProof.mockResolvedValueOnce(null);
    const res = await request(buildApp('owner-1')).get('/api/v1/signatures/other-orgs-sig/audit-proof');
    expect(res.status).toBe(404);
  });
});

// ─── GET /signatures/export (membership-only) ────────────────────────────────
describe('GET /api/v1/signatures/export — membership-only, owner-inclusive', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(buildApp()).get('/api/v1/signatures/export');
    expect(res.status).toBe(401);
    expect(bulkExportSignatures).not.toHaveBeenCalled();
  });

  it('OWNER (no org_members row, resolved via profiles.org_id) gets a NON-403 success', async () => {
    const res = await request(buildApp('owner-1')).get('/api/v1/signatures/export');
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
    // Resolver was consulted (owner-inclusive), and the export ran for the
    // caller-derived org — never a body/org_members-derived one.
    expect(getCallerOrgId).toHaveBeenCalledWith('owner-1');
    expect(bulkExportSignatures).toHaveBeenCalledTimes(1);
    expect(bulkExportSignatures.mock.calls[0][0].orgId).toBe('org-owned');
  });

  it('returns 403 (with the preserved message) when the caller has no org', async () => {
    getCallerOrgId.mockResolvedValue(null);
    const res = await request(buildApp('stranger')).get('/api/v1/signatures/export');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('No organization membership found');
    expect(bulkExportSignatures).not.toHaveBeenCalled();
  });

  it('does NOT require admin for the membership-only export (owner who is non-admin still 200)', async () => {
    // Membership-only gate must ignore isCallerOrgAdmin entirely.
    isCallerOrgAdmin.mockResolvedValue(false);
    const res = await request(buildApp('member-1')).get('/api/v1/signatures/export');
    expect(res.status).toBe(200);
    expect(isCallerOrgAdmin).not.toHaveBeenCalled();
  });
});

// ─── GET /signatures/soc2-evidence (admin-gated) ─────────────────────────────
describe('GET /api/v1/signatures/soc2-evidence — admin-gated, owner-inclusive', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(buildApp()).get(`/api/v1/signatures/soc2-evidence?from=${FROM}&to=${TO}`);
    expect(res.status).toBe(401);
  });

  it('OWNER (admin via canonical resolver, no org_members row) gets a NON-403 success', async () => {
    const res = await request(buildApp('owner-1')).get(
      `/api/v1/signatures/soc2-evidence?from=${FROM}&to=${TO}`,
    );
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
    expect(getCallerOrgId).toHaveBeenCalledWith('owner-1');
    expect(isCallerOrgAdmin).toHaveBeenCalledWith('owner-1', 'org-owned');
    expect(generateSoc2EvidenceBundle).toHaveBeenCalledWith('org-owned', FROM, TO);
  });

  it('returns 403 when the caller has no org', async () => {
    getCallerOrgId.mockResolvedValue(null);
    const res = await request(buildApp('stranger')).get(
      `/api/v1/signatures/soc2-evidence?from=${FROM}&to=${TO}`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Organization administrator role required');
    expect(generateSoc2EvidenceBundle).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is in an org but is NOT an admin', async () => {
    isCallerOrgAdmin.mockResolvedValue(false);
    const res = await request(buildApp('member-1')).get(
      `/api/v1/signatures/soc2-evidence?from=${FROM}&to=${TO}`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Organization administrator role required');
    expect(generateSoc2EvidenceBundle).not.toHaveBeenCalled();
  });

  it('returns 400 when the required date params are missing', async () => {
    const res = await request(buildApp('owner-1')).get('/api/v1/signatures/soc2-evidence');
    expect(res.status).toBe(400);
  });
});

// ─── GET /signatures/gdpr-article30 (admin-gated) ────────────────────────────
describe('GET /api/v1/signatures/gdpr-article30 — admin-gated, owner-inclusive', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(buildApp()).get('/api/v1/signatures/gdpr-article30');
    expect(res.status).toBe(401);
  });

  it('OWNER (admin via canonical resolver, no org_members row) gets a NON-403 success', async () => {
    const res = await request(buildApp('owner-1')).get('/api/v1/signatures/gdpr-article30');
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
    expect(getCallerOrgId).toHaveBeenCalledWith('owner-1');
    expect(isCallerOrgAdmin).toHaveBeenCalledWith('owner-1', 'org-owned');
    expect(generateGdprArticle30Export).toHaveBeenCalledWith('org-owned');
  });

  it('returns 403 when the caller has no org', async () => {
    getCallerOrgId.mockResolvedValue(null);
    const res = await request(buildApp('stranger')).get('/api/v1/signatures/gdpr-article30');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Organization administrator role required');
    expect(generateGdprArticle30Export).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is in an org but is NOT an admin', async () => {
    isCallerOrgAdmin.mockResolvedValue(false);
    const res = await request(buildApp('member-1')).get('/api/v1/signatures/gdpr-article30');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Organization administrator role required');
    expect(generateGdprArticle30Export).not.toHaveBeenCalled();
  });
});

// ─── GET /signatures/eidas-report (admin-gated) ──────────────────────────────
describe('GET /api/v1/signatures/eidas-report — admin-gated, owner-inclusive', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(buildApp()).get(`/api/v1/signatures/eidas-report?from=${FROM}&to=${TO}`);
    expect(res.status).toBe(401);
  });

  it('OWNER (admin via canonical resolver, no org_members row) gets a NON-403 success', async () => {
    const res = await request(buildApp('owner-1')).get(
      `/api/v1/signatures/eidas-report?from=${FROM}&to=${TO}`,
    );
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
    expect(getCallerOrgId).toHaveBeenCalledWith('owner-1');
    expect(isCallerOrgAdmin).toHaveBeenCalledWith('owner-1', 'org-owned');
    expect(generateEidasComplianceReport).toHaveBeenCalledWith('org-owned', FROM, TO);
  });

  it('returns 403 when the caller has no org', async () => {
    getCallerOrgId.mockResolvedValue(null);
    const res = await request(buildApp('stranger')).get(
      `/api/v1/signatures/eidas-report?from=${FROM}&to=${TO}`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Organization administrator role required');
    expect(generateEidasComplianceReport).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is in an org but is NOT an admin', async () => {
    isCallerOrgAdmin.mockResolvedValue(false);
    const res = await request(buildApp('member-1')).get(
      `/api/v1/signatures/eidas-report?from=${FROM}&to=${TO}`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Organization administrator role required');
    expect(generateEidasComplianceReport).not.toHaveBeenCalled();
  });

  it('returns 400 when the required date params are missing', async () => {
    const res = await request(buildApp('owner-1')).get('/api/v1/signatures/eidas-report');
    expect(res.status).toBe(400);
  });
});
