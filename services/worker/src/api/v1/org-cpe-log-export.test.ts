/**
 * Tests for the ORG-ADMIN per-member CPE compliance-log export endpoint
 * (SCRUM-1849 / SCRUM-1863 — CPE-R3).
 *
 * POST /api/v1/exports/org/cpe-log
 *   Body: { user_id (member to export), period_start, period_end, format }
 *
 * Authorization matrix (the heart of this story):
 *   - unauthenticated                                  → 401
 *   - caller is NOT an org admin (INDIVIDUAL/member)   → 403
 *   - caller IS admin of org A, target is in org B     → 403  (CROSS-ORG)
 *   - caller IS admin of org A, target is in NO org    → 403  (non-member)
 *   - caller IS admin of org A, target is in org A     → 200
 *
 * The worker (`generateCpeLogExport`) is mocked — these tests assert the
 * AUTHORIZATION + delegation contract, not PDF/JSON generation (covered by the
 * worker's own suite on the base branch).
 *
 * RLS NOTE: the worker uses a service_role Supabase client which BYPASSES RLS.
 * Cross-org isolation for this admin-acts-on-member flow is therefore enforced
 * in application code (`isCallerOrgAdmin` + `isUserMemberOfOrg`), and is what
 * these tests exercise. The named cross-org case is
 * `org-cpe-export.cross-org.POST.returns.403` per SCRUM-1863.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Mocks ───────────────────────────────────────────
const generateCpeLogExport = vi.fn();

vi.mock('../../exports/cpe-log-export.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../exports/cpe-log-export.js')>();
  return {
    ...actual,
    generateCpeLogExport: (...args: unknown[]) => generateCpeLogExport(...args),
  };
});

// Org-auth helpers are mocked so each test can drive the admin/membership
// decision directly. (Their own DB-level behavior is covered in
// api/_org-auth.test.ts.) The endpoint uses the `*Result` variants so it can
// tell a definitive negative (403) from a DB/operational error (500); these
// mocks resolve `{ value, error }`.
const isCallerOrgAdminResult = vi.fn();
const isUserMemberOfOrgResult = vi.fn();
const getCallerOrgIdResult = vi.fn();

vi.mock('../_org-auth.js', () => ({
  isCallerOrgAdminResult: (...args: unknown[]) => isCallerOrgAdminResult(...args),
  isUserMemberOfOrgResult: (...args: unknown[]) => isUserMemberOfOrgResult(...args),
  getCallerOrgIdResult: (...args: unknown[]) => getCallerOrgIdResult(...args),
}));

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn(), storage: { from: vi.fn() } },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  config: { frontendUrl: 'https://app.arkova.io', bitcoinNetwork: 'mainnet' },
}));

import {
  orgCpeLogExportRouter,
  orgCpeLogExportRateLimiter,
} from './org-cpe-log-export.js';
import { db } from '../../utils/db.js';
import { setRateLimitStore } from '../../utils/rateLimit.js';

const fromMock = db.from as unknown as ReturnType<typeof vi.fn>;

/** Capture audit_events inserts so CC7 + actor attribution can be asserted. */
const auditInserts: Array<Record<string, unknown>> = [];
function wireAuditCapture() {
  fromMock.mockImplementation((table: string) => {
    if (table === 'audit_events') {
      return {
        insert: vi.fn((row: Record<string, unknown>) => {
          auditInserts.push(row);
          return Promise.resolve({ error: null });
        }),
      };
    }
    return { insert: vi.fn().mockResolvedValue({ error: null }) };
  });
}

// ─── Helpers ─────────────────────────────────────────
const SUCCESS_RESULT = {
  request_id: 'req-1',
  record_count: 3,
  disclaimer: 'disclaimer',
  exports: {
    pdf: { signed_url: 'https://storage.example/exports/x.pdf?token=a', path: 'p.pdf', expires_in: 3600 },
    json: { signed_url: 'https://storage.example/exports/x.json?token=b', path: 'p.json', expires_in: 3600 },
  },
};

/** Build an app injecting a fixed authenticated admin user. */
function createApp(userId: string | undefined) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) req.authUserId = userId;
    next();
  });
  app.use('/exports/org/cpe-log', orgCpeLogExportRateLimiter, orgCpeLogExportRouter);
  return app;
}

const VALID_BODY = {
  user_id: 'member-A', // the member to export
  period_start: '2026-01-01',
  period_end: '2026-12-31',
  format: 'pdf',
};

/** Default: caller is admin of org-A; target is a member of org-A. */
function asAdminOfOrgAWithTargetInOrgA() {
  getCallerOrgIdResult.mockResolvedValue({ value: 'org-A', error: false });
  isCallerOrgAdminResult.mockResolvedValue({ value: true, error: false });
  isUserMemberOfOrgResult.mockResolvedValue({ value: true, error: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Fresh rate-limit store per test — the limiter is a module-level singleton,
  // so without this the shared `admin-A` bucket fills across the file run.
  setRateLimitStore(new Map());
  auditInserts.length = 0;
  wireAuditCapture();
  generateCpeLogExport.mockResolvedValue(SUCCESS_RESULT);
  asAdminOfOrgAWithTargetInOrgA();
});

// ─── Auth + role ─────────────────────────────────────
describe('POST /exports/org/cpe-log — auth + ORG_ADMIN gate', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(createApp(undefined)).post('/exports/org/cpe-log').send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(generateCpeLogExport).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller belongs to no organization', async () => {
    getCallerOrgIdResult.mockResolvedValue({ value: null, error: false });
    const res = await request(createApp('admin-A')).post('/exports/org/cpe-log').send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(generateCpeLogExport).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is NOT an org admin (INDIVIDUAL/member)', async () => {
    isCallerOrgAdminResult.mockResolvedValue({ value: false, error: false });
    const res = await request(createApp('member-X')).post('/exports/org/cpe-log').send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(generateCpeLogExport).not.toHaveBeenCalled();
  });
});

// ─── 403 vs 500: operational lookup errors must NOT masquerade as 403 ─
describe('POST /exports/org/cpe-log — DB/operational errors return 500, not 403', () => {
  it('returns 500 when the org-resolution lookup hits a DB error', async () => {
    // error:true means the lookup could not be determined — an operational
    // fault, NOT a definitive "no org" → must be 500, never a misleading 403.
    getCallerOrgIdResult.mockResolvedValue({ value: null, error: true });
    const res = await request(createApp('admin-A')).post('/exports/org/cpe-log').send(VALID_BODY);
    expect(res.status).toBe(500);
    expect(generateCpeLogExport).not.toHaveBeenCalled();
  });

  it('returns 500 when the admin-role lookup hits a DB error', async () => {
    isCallerOrgAdminResult.mockResolvedValue({ value: false, error: true });
    const res = await request(createApp('admin-A')).post('/exports/org/cpe-log').send(VALID_BODY);
    expect(res.status).toBe(500);
    expect(generateCpeLogExport).not.toHaveBeenCalled();
  });

  it('returns 500 when the target-membership lookup hits a DB error', async () => {
    isUserMemberOfOrgResult.mockResolvedValue({ value: false, error: true });
    const res = await request(createApp('admin-A')).post('/exports/org/cpe-log').send(VALID_BODY);
    expect(res.status).toBe(500);
    expect(generateCpeLogExport).not.toHaveBeenCalled();
  });

  it('still returns 403 (not 500) for a definitive negative — error:false', async () => {
    // Sanity: a clean negative is a 403; only error:true escalates to 500.
    isUserMemberOfOrgResult.mockResolvedValue({ value: false, error: false });
    const res = await request(createApp('admin-A'))
      .post('/exports/org/cpe-log')
      .send({ ...VALID_BODY, user_id: 'member-B' });
    expect(res.status).toBe(403);
  });
});

// ─── Cross-org isolation (KEY DELIVERABLE) ───────────
describe('POST /exports/org/cpe-log — cross-org isolation', () => {
  // Named per SCRUM-1863: org-cpe-export.cross-org.POST.returns.403
  it('org-cpe-export.cross-org.POST.returns.403 — admin of org A cannot export a member of org B', async () => {
    // Caller IS a valid admin of org-A, but the target is NOT in org-A.
    isCallerOrgAdminResult.mockResolvedValue({ value: true, error: false });
    isUserMemberOfOrgResult.mockResolvedValue({ value: false, error: false }); // member-B is not in org-A
    const res = await request(createApp('admin-A'))
      .post('/exports/org/cpe-log')
      .send({ ...VALID_BODY, user_id: 'member-B' });
    expect(res.status).toBe(403);
    expect(generateCpeLogExport).not.toHaveBeenCalled();
    // The membership check was scoped to the CALLER's resolved org, never the body.
    expect(isUserMemberOfOrgResult).toHaveBeenCalledWith('member-B', 'org-A');
  });

  it('returns 403 when the target user is a member of NO org (non-member)', async () => {
    isCallerOrgAdminResult.mockResolvedValue({ value: true, error: false });
    isUserMemberOfOrgResult.mockResolvedValue({ value: false, error: false });
    const res = await request(createApp('admin-A'))
      .post('/exports/org/cpe-log')
      .send({ ...VALID_BODY, user_id: 'stranger' });
    expect(res.status).toBe(403);
    expect(generateCpeLogExport).not.toHaveBeenCalled();
  });

  it('does NOT trust an org_id from the request body (no body org override)', async () => {
    isUserMemberOfOrgResult.mockResolvedValue({ value: false, error: false });
    const res = await request(createApp('admin-A'))
      .post('/exports/org/cpe-log')
      .send({ ...VALID_BODY, user_id: 'member-B', org_id: 'org-B' });
    // org_id in body is rejected by .strict() (400) OR ignored — either way the
    // export must not run with a body-supplied org.
    expect([400, 403]).toContain(res.status);
    expect(generateCpeLogExport).not.toHaveBeenCalled();
  });
});

// ─── Validation ──────────────────────────────────────
describe('POST /exports/org/cpe-log — Zod validation', () => {
  it('returns 400 with structured details on an invalid date', async () => {
    const res = await request(createApp('admin-A'))
      .post('/exports/org/cpe-log')
      .send({ ...VALID_BODY, period_start: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it('returns 400 on an unsupported format', async () => {
    const res = await request(createApp('admin-A'))
      .post('/exports/org/cpe-log')
      .send({ ...VALID_BODY, format: 'xlsx' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when period_end precedes period_start', async () => {
    const res = await request(createApp('admin-A'))
      .post('/exports/org/cpe-log')
      .send({ ...VALID_BODY, period_start: '2026-12-31', period_end: '2026-01-01' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when user_id (the member) is missing', async () => {
    const res = await request(createApp('admin-A'))
      .post('/exports/org/cpe-log')
      .send({ period_start: '2026-01-01', period_end: '2026-12-31', format: 'pdf' });
    expect(res.status).toBe(400);
  });
});

// ─── Happy path + delegation ─────────────────────────
describe('POST /exports/org/cpe-log — success (admin exports own-org member)', () => {
  it('returns 200 with signed URLs for BOTH formats + request_id', async () => {
    const res = await request(createApp('admin-A')).post('/exports/org/cpe-log').send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.exports.pdf.signed_url).toMatch(/^https:\/\//);
    expect(res.body.exports.json.signed_url).toMatch(/^https:\/\//);
    expect(typeof res.body.request_id).toBe('string');
    expect(res.body.record_count).toBe(3);
    // The raw target member user_id is intentionally NOT echoed back on the
    // frozen v1 contract (PR #1045 review) — the caller already supplied it.
    expect(res.body.member_id).toBeUndefined();
    expect(generateCpeLogExport).toHaveBeenCalledTimes(1);
  });

  it('delegates to the R2 worker with the TARGET userId + the CALLER org', async () => {
    await request(createApp('admin-A')).post('/exports/org/cpe-log').send(VALID_BODY);
    const args = generateCpeLogExport.mock.calls[0][0];
    expect(args.userId).toBe('member-A'); // the member, not the admin
    expect(args.orgId).toBe('org-A'); // resolved from the caller, not the body
    expect(args.periodStart).toBe('2026-01-01');
    expect(args.periodEnd).toBe('2026-12-31');
    expect(typeof args.requestId).toBe('string');
    expect(args.requestId.length).toBeGreaterThan(0);
  });

  it('returns 500 (not an unhandled throw) when the worker fails', async () => {
    generateCpeLogExport.mockRejectedValueOnce(new Error('boom'));
    const res = await request(createApp('admin-A')).post('/exports/org/cpe-log').send(VALID_BODY);
    expect(res.status).toBe(500);
  });
});

// ─── Audit: actor = admin, target in metadata, CC7 no-content ─
describe('POST /exports/org/cpe-log — admin audit event (cpe_log.exported)', () => {
  it('emits a cpe_log.exported row with actor_id = ADMIN and the target member in metadata', async () => {
    await request(createApp('admin-A')).post('/exports/org/cpe-log').send(VALID_BODY);
    const row = auditInserts.find(
      (r) => r.event_type === 'cpe_log.exported' && r.target_type === 'org_cpe_log_export',
    );
    expect(row).toBeDefined();
    expect(row?.actor_id).toBe('admin-A'); // the admin, NOT the member
    expect(row?.event_category).toBe('ADMIN');
    expect(row?.org_id).toBe('org-A');
    const details = JSON.parse(row?.details as string);
    expect(details.target_member_id).toBe('member-A');
    expect(details.acting_as).toBe('ORG_ADMIN');
    expect(details.org_id ?? 'org-A').toBeTruthy(); // org context present (row.org_id)
  });

  it('CC7: audit details carry NO export body content (only ids/period/format/count)', async () => {
    await request(createApp('admin-A')).post('/exports/org/cpe-log').send(VALID_BODY);
    const row = auditInserts.find((r) => r.target_type === 'org_cpe_log_export');
    const details = JSON.parse(row?.details as string) as Record<string, unknown>;
    // Allow-list of metadata keys; anything else is a leak.
    const allowed = new Set([
      'target_member_id',
      'acting_as',
      'period_start',
      'period_end',
      'format',
      'record_count',
      'request_id',
    ]);
    for (const key of Object.keys(details)) {
      expect(allowed.has(key)).toBe(true);
    }
    // No per-credential content keys.
    const serialized = JSON.stringify(details).toLowerCase();
    for (const banned of ['title', 'provider', 'public_id', 'verification_url', 'records', 'signed_url']) {
      expect(serialized).not.toContain(banned);
    }
  });

  it('does not emit the admin audit row on a cross-org 403 (export never ran)', async () => {
    isUserMemberOfOrgResult.mockResolvedValue({ value: false, error: false });
    await request(createApp('admin-A'))
      .post('/exports/org/cpe-log')
      .send({ ...VALID_BODY, user_id: 'member-B' });
    expect(auditInserts.find((r) => r.target_type === 'org_cpe_log_export')).toBeUndefined();
  });
});

// ─── Rate limit (separate scope) ─────────────────────
describe('POST /exports/org/cpe-log — rate limit (10/admin/hour, scope org-cpe-log-export)', () => {
  it('allows 10 requests then 429s the 11th within the hour, with Retry-After', async () => {
    const app = createApp('rate-admin');
    for (let i = 0; i < 10; i++) {
      const ok = await request(app).post('/exports/org/cpe-log').send(VALID_BODY);
      expect(ok.status).toBe(200);
    }
    const limited = await request(app).post('/exports/org/cpe-log').send(VALID_BODY);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });
});
