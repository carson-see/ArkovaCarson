/**
 * Tests for Organization Verification API (GAP-10)
 *
 * Covers:
 *   - POST /verify-ein: EIN submission, validation, duplicate detection
 *   - POST /verify-domain: Domain verification initiation, email sending
 *   - POST /confirm-domain: Code confirmation, expiry, full verification
 *   - POST /dev-verify: Dev-only bypass
 *   - GET /verification-status: Status retrieval
 *   - Auth + org membership guards on all routes
 *   - ORG_ADMIN gate on the three write routes (2026-08-12)
 *   - KYB provenance ratchet (see the final describe block)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Mocks (must be before imports) ───

const mockFrom = vi.fn();

vi.mock('../../config.js', () => ({
  config: {
    nodeEnv: 'development',
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../utils/db.js', () => ({
  db: {
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

const mockSendEmail = vi.fn();
vi.mock('../../email/sender.js', () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
}));

const mockBuildDomainVerificationEmail = vi.fn();
vi.mock('../../email/templates.js', () => ({
  buildDomainVerificationEmail: (...args: unknown[]) => mockBuildDomainVerificationEmail(...args),
}));

import { orgVerificationRouter } from './orgVerification.js';

// ─── Helpers ───

function createApp(userId?: string) {
  const app = express();
  app.use(express.json());
  // Inject userId into request (simulating auth middleware)
  if (userId) {
    app.use((req, _res, next) => {
      (req as unknown as { userId: string }).userId = userId;
      next();
    });
  }
  app.use('/org', orgVerificationRouter);
  return app;
}

/** Build a fluent chain for Supabase query mocking.
 *  The chain is thenable so `await db.from(...).update(...).eq(...)` resolves. */
function mockQuery(result: { data?: unknown; error?: unknown }) {
  const chain: Record<string, unknown> = {};
  const terminal = () => Promise.resolve(result);
  // Make chain itself thenable (for cases where .eq() is the final call)
  chain.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    terminal().then(resolve, reject);
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.neq = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockImplementation(terminal);
  chain.maybeSingle = vi.fn().mockImplementation(terminal);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Auth Guards ───

describe('auth guards', () => {
  it('returns 401 when no userId on all routes', async () => {
    const app = createApp(); // no userId injected

    const routes = [
      { method: 'post', path: '/org/verify-ein', body: { ein: '12-3456789' } },
      { method: 'post', path: '/org/verify-domain', body: {} },
      { method: 'post', path: '/org/confirm-domain', body: { code: '123456' } },
      { method: 'post', path: '/org/dev-verify', body: {} },
      { method: 'get', path: '/org/verification-status' },
    ];

    for (const route of routes) {
      const res = route.method === 'get'
        ? await request(app).get(route.path)
        : await request(app).post(route.path).send(route.body);
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Authentication');
    }
  });

  it('returns 400 when user has no org on all routes', async () => {
    const app = createApp('user-no-org');

    // getUserOrgId returns null
    const profileChain = mockQuery({ data: { org_id: null } });
    mockFrom.mockReturnValue(profileChain);

    const routes = [
      { method: 'post', path: '/org/verify-ein', body: { ein: '12-3456789' } },
      { method: 'post', path: '/org/verify-domain', body: {} },
      { method: 'post', path: '/org/confirm-domain', body: { code: '123456' } },
      { method: 'post', path: '/org/dev-verify', body: {} },
      { method: 'get', path: '/org/verification-status' },
    ];

    for (const route of routes) {
      const res = route.method === 'get'
        ? await request(app).get(route.path)
        : await request(app).post(route.path).send(route.body);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('organization');
    }
  });
});

// ─── POST /verify-ein ───

describe('POST /verify-ein', () => {
  const app = createApp('user-123');

  function setupMocks(opts: {
    orgId?: string | null;
    existingEin?: { id: string; display_name: string } | null;
    updateError?: unknown;
    auditError?: unknown;
  }) {
    const callIdx = { current: 0 };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        // role: 'ORG_ADMIN' — the route is ORG_ADMIN-gated (2026-08-12); the
        // caller here is an admin via the _org-auth profile fallback
        // (org_members hits the default null branch below).
        return mockQuery({ data: { org_id: opts.orgId ?? 'org-abc', role: 'ORG_ADMIN' } });
      }
      if (table === 'organizations') {
        callIdx.current++;
        if (callIdx.current === 1) {
          // duplicate check
          return mockQuery({ data: opts.existingEin ?? null });
        }
        // update
        return mockQuery({ data: null, error: opts.updateError ?? null });
      }
      if (table === 'audit_events') {
        return mockQuery({ data: null, error: opts.auditError ?? null });
      }
      return mockQuery({ data: null });
    });
  }

  it('rejects missing EIN', async () => {
    setupMocks({});
    const res = await request(app).post('/org/verify-ein').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('EIN');
  });

  it('rejects EIN shorter than 5 characters', async () => {
    setupMocks({});
    const res = await request(app).post('/org/verify-ein').send({ ein: '123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('5');
  });

  it('rejects EIN longer than 32 characters', async () => {
    // Upper bound added 2026-08-12: ein_tax_id is an unbounded text column
    // (prod CHECK is length >= 5 only) and the value is L3 Confidential —
    // an unbounded client-supplied string has no business being stored.
    // Format stays deliberately loose (international tax IDs — e.g. Kenyan
    // KRA PINs are 11 alphanumerics — must keep working; no ^\d{9}$ pin).
    setupMocks({});
    const res = await request(app).post('/org/verify-ein').send({ ein: 'A'.repeat(33) });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('32');
  });

  it('accepts a 32-character EIN (boundary)', async () => {
    setupMocks({});
    const res = await request(app).post('/org/verify-ein').send({ ein: 'A'.repeat(32) });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PENDING');
  });

  it('returns 409 when EIN is already registered', async () => {
    setupMocks({ existingEin: { id: 'other-org', display_name: 'Other Corp' } });
    const res = await request(app).post('/org/verify-ein').send({ ein: '12-3456789' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already registered');
  });

  it('submits EIN and returns PENDING', async () => {
    setupMocks({});
    const res = await request(app).post('/org/verify-ein').send({ ein: '12-3456789' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PENDING');
  });

  it('returns 500 when update fails', async () => {
    setupMocks({ updateError: { message: 'db error' } });
    const res = await request(app).post('/org/verify-ein').send({ ein: '12-3456789' });
    expect(res.status).toBe(500);
  });
});

// ─── POST /verify-domain ───

describe('POST /verify-domain', () => {
  const app = createApp('user-123');

  function setupMocks(opts: {
    orgId?: string | null;
    orgData?: { domain?: string | null; domain_verified?: boolean } | null;
    orgError?: unknown;
    updateError?: unknown;
  }) {
    const orgCallIdx = { current: 0 };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        // ORG_ADMIN via the _org-auth profile fallback (route is admin-gated).
        return mockQuery({ data: { org_id: opts.orgId ?? 'org-abc', role: 'ORG_ADMIN' } });
      }
      if (table === 'organizations') {
        orgCallIdx.current++;
        if (orgCallIdx.current === 1) {
          // select domain
          return mockQuery({
            data: opts.orgData ?? { domain: 'example.com', domain_verified: false },
            error: opts.orgError ?? null,
          });
        }
        // update token
        return mockQuery({ data: null, error: opts.updateError ?? null });
      }
      return mockQuery({ data: null });
    });
  }

  it('returns 400 when org has no domain', async () => {
    setupMocks({ orgData: { domain: null, domain_verified: false } });
    const res = await request(app).post('/org/verify-domain').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('domain set');
  });

  it('returns 400 when domain already verified', async () => {
    setupMocks({ orgData: { domain: 'example.com', domain_verified: true } });
    const res = await request(app).post('/org/verify-domain').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('already verified');
  });

  it('returns devCode in development mode', async () => {
    setupMocks({});
    const res = await request(app).post('/org/verify-domain').send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(res.body.devCode).toBeDefined();
    expect(res.body.devCode).toHaveLength(6);
    expect(res.body.domain).toBe('example.com');
  });

  it('returns 500 when org fetch fails', async () => {
    setupMocks({ orgError: { message: 'db error' } });
    const res = await request(app).post('/org/verify-domain').send({});
    expect(res.status).toBe(500);
  });

  it('returns 500 when token update fails', async () => {
    setupMocks({ updateError: { message: 'db error' } });
    const res = await request(app).post('/org/verify-domain').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('start domain');
  });
});

// Note: Production email-sending path cannot be tested here because `isDev`
// is captured at module load time. Would require a separate test file with
// config.nodeEnv mocked to 'production' before import.

// ─── POST /confirm-domain ───

describe('POST /confirm-domain', () => {
  const app = createApp('user-123');

  function setupMocks(opts: {
    orgData?: Record<string, unknown> | null;
    orgError?: unknown;
    updateError?: unknown;
  }) {
    const orgCallIdx = { current: 0 };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        // ORG_ADMIN via the _org-auth profile fallback (route is admin-gated).
        return mockQuery({ data: { org_id: 'org-abc', role: 'ORG_ADMIN' } });
      }
      if (table === 'organizations') {
        orgCallIdx.current++;
        if (orgCallIdx.current === 1) {
          return mockQuery({
            data: opts.orgData ?? {
              domain_verification_token: '123456:abcdef',
              domain_verification_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
              ein_tax_id: null,
              domain_verified: false,
            },
            error: opts.orgError ?? null,
          });
        }
        // update
        return mockQuery({ data: null, error: opts.updateError ?? null });
      }
      if (table === 'audit_events') {
        return mockQuery({ data: null });
      }
      return mockQuery({ data: null });
    });
  }

  it('rejects missing code', async () => {
    setupMocks({});
    const res = await request(app).post('/org/confirm-domain').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('code is required');
  });

  it('rejects code shorter than 6 chars', async () => {
    setupMocks({});
    const res = await request(app).post('/org/confirm-domain').send({ code: '123' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when domain already verified', async () => {
    setupMocks({
      orgData: {
        domain_verification_token: '123456:abcdef',
        domain_verification_token_expires_at: null,
        ein_tax_id: null,
        domain_verified: true,
      },
    });
    const res = await request(app).post('/org/confirm-domain').send({ code: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('already verified');
  });

  it('returns 400 when no pending verification', async () => {
    setupMocks({
      orgData: {
        domain_verification_token: null,
        domain_verification_token_expires_at: null,
        ein_tax_id: null,
        domain_verified: false,
      },
    });
    const res = await request(app).post('/org/confirm-domain').send({ code: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('No pending');
  });

  it('returns 400 when code expired', async () => {
    setupMocks({
      orgData: {
        domain_verification_token: '123456:abcdef',
        domain_verification_token_expires_at: new Date(Date.now() - 3600_000).toISOString(),
        ein_tax_id: null,
        domain_verified: false,
      },
    });
    const res = await request(app).post('/org/confirm-domain').send({ code: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('expired');
  });

  it('returns 400 when code is wrong', async () => {
    setupMocks({});
    const res = await request(app).post('/org/confirm-domain').send({ code: '999999' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid');
  });

  it('confirms domain (partial verification — no EIN)', async () => {
    setupMocks({});
    const res = await request(app).post('/org/confirm-domain').send({ code: '123456' });
    expect(res.status).toBe(200);
    expect(res.body.domainVerified).toBe(true);
    expect(res.body.verificationStatus).toBe('PENDING');
    expect(res.body.message).toContain('Submit EIN');
  });

  it('confirms domain + fully verifies when EIN present', async () => {
    setupMocks({
      orgData: {
        domain_verification_token: '123456:abcdef',
        domain_verification_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
        ein_tax_id: '12-3456789',
        domain_verified: false,
      },
    });
    const res = await request(app).post('/org/confirm-domain').send({ code: '123456' });
    expect(res.status).toBe(200);
    expect(res.body.domainVerified).toBe(true);
    expect(res.body.verificationStatus).toBe('VERIFIED');
    expect(res.body.message).toContain('fully verified');
  });

  it('returns 500 when update fails', async () => {
    setupMocks({ updateError: { message: 'db error' } });
    const res = await request(app).post('/org/confirm-domain').send({ code: '123456' });
    expect(res.status).toBe(500);
  });
});

// ─── POST /dev-verify ───

describe('POST /dev-verify', () => {
  it('auto-verifies org in dev mode', async () => {
    const app = createApp('user-123');

    const orgCallIdx = { current: 0 };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return mockQuery({ data: { org_id: 'org-abc' } });
      }
      if (table === 'organizations') {
        orgCallIdx.current++;
        return mockQuery({ data: null, error: null });
      }
      if (table === 'audit_events') {
        return mockQuery({ data: null });
      }
      return mockQuery({ data: null });
    });

    const res = await request(app).post('/org/dev-verify').send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('VERIFIED');
  });

  // Note: Production 403 test cannot run here because `isDev` is captured at
  // module load time. Would require separate test file with production config.

  it('returns 500 when update fails', async () => {
    const app = createApp('user-123');

    mockFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return mockQuery({ data: { org_id: 'org-abc' } });
      }
      if (table === 'organizations') {
        return mockQuery({ data: null, error: { message: 'db error' } });
      }
      return mockQuery({ data: null });
    });

    const res = await request(app).post('/org/dev-verify').send({});
    expect(res.status).toBe(500);
  });
});

// ─── GET /verification-status ───

describe('GET /verification-status', () => {
  const app = createApp('user-123');

  it('returns verification status', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return mockQuery({ data: { org_id: 'org-abc' } });
      }
      if (table === 'organizations') {
        return mockQuery({
          data: {
            verification_status: 'VERIFIED',
            domain: 'example.com',
            domain_verified: true,
            domain_verification_method: 'email',
            domain_verified_at: '2026-03-01T00:00:00Z',
            ein_tax_id: '12-3456789',
          },
        });
      }
      return mockQuery({ data: null });
    });

    const res = await request(app).get('/org/verification-status');
    expect(res.status).toBe(200);
    expect(res.body.verificationStatus).toBe('VERIFIED');
    expect(res.body.domain).toBe('example.com');
    expect(res.body.domainVerified).toBe(true);
    expect(res.body.hasEin).toBe(true);
    // Constitution 1.4: actual EIN never returned
    expect(res.body.ein_tax_id).toBeUndefined();
  });

  it('returns UNVERIFIED when no status set', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return mockQuery({ data: { org_id: 'org-abc' } });
      }
      if (table === 'organizations') {
        return mockQuery({
          data: {
            verification_status: null,
            domain: null,
            domain_verified: null,
            domain_verification_method: null,
            domain_verified_at: null,
            ein_tax_id: null,
          },
        });
      }
      return mockQuery({ data: null });
    });

    const res = await request(app).get('/org/verification-status');
    expect(res.status).toBe(200);
    expect(res.body.verificationStatus).toBe('UNVERIFIED');
    expect(res.body.domainVerified).toBe(false);
    expect(res.body.hasEin).toBe(false);
  });

  it('returns 500 when org fetch fails', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return mockQuery({ data: { org_id: 'org-abc' } });
      }
      if (table === 'organizations') {
        return mockQuery({ data: null, error: { message: 'db error' } });
      }
      return mockQuery({ data: null });
    });

    const res = await request(app).get('/org/verification-status');
    expect(res.status).toBe(500);
  });
});

// ─── KYB provenance ratchet (two-grade verification decision, 2026-08-11) ───

/**
 * Two-grade org verification decision (self-serve vs provider KYB): see this
 * folder's agents.md, 2026-08-11 entry, for the full record. The invariant this
 * suite pins: self-serve handlers in THIS file never stamp a `kyb_*` column, so
 * `kyb_completed_at IS NULL` stays meaningful as the column-level discriminator
 * (`kyb_completed_at` is the only webhook-exclusive `kyb_*` column — see
 * agents.md on why `kyb_provider`/`kyb_submitted_at` are weaker signals).
 *
 * Scope, stated precisely so nobody over-trusts it:
 *   - Covers ALL FIVE organizations write sites in this file's handlers
 *     (verify-ein, verify-domain, confirm-domain ×2 branches, dev-verify),
 *     via BOTH `.update()` and `.insert()` payload capture. A future `.upsert()`
 *     or `db.rpc()` fails loudly (unmocked → 500 → status assert goes red).
 *   - Prefix-based (`kyb_*`) over captured payload keys — a future kyb-prefixed
 *     column is covered, but only for writes that actually FIRE under these
 *     fixtures. The full-verification fixture deliberately carries
 *     `kyb_provider`/`kyb_submitted_at` state so a state-conditional stamp
 *     (the `...(cond ? {...} : {})` house idiom) fires and is caught.
 *   - This file's handlers ONLY. Writers elsewhere (middesk.ts, stripe
 *     handlers until PR #2134 lands) are outside this suite — see agents.md
 *     follow-ups for the repo-wide writer lint.
 *
 * Mutation-verified: adding `kyb_completed_at` to the confirm-domain update, or
 * `kyb_submitted_at` to the verify-domain token update, turns exactly one test
 * red. Payload capture happens at call time; that the writes actually execute
 * is pinned separately by each route's pre-existing "returns 500 when update
 * fails" test (a dropped await would break those, not this suite).
 */
describe('KYB provenance ratchet — self-serve writes never stamp kyb_* columns', () => {
  const app = createApp('user-123');

  /** Collects every payload passed to organizations.update()/.insert() during a request. */
  function captureOrgUpdates(orgSelectData: Record<string, unknown> | null) {
    const captured: Record<string, unknown>[] = [];
    mockFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        // ORG_ADMIN via the _org-auth profile fallback: the three self-serve
        // routes are ORG_ADMIN-gated (2026-08-12). This does NOT weaken the
        // ratchet — the invariant under test is payload shape, and the routes
        // must authorize before any payload is written at all.
        return mockQuery({ data: { org_id: 'org-abc', role: 'ORG_ADMIN' } });
      }
      if (table === 'organizations') {
        const chain = mockQuery({ data: orgSelectData, error: null });
        const capture = (payload: Record<string, unknown>) => {
          // Snapshot, not reference: a handler that mutated the payload object
          // after the call must not be able to rewrite what we captured.
          captured.push({ ...payload });
          return chain;
        };
        (chain.update as ReturnType<typeof vi.fn>).mockImplementation(capture);
        (chain.insert as ReturnType<typeof vi.fn>).mockImplementation(capture);
        return chain;
      }
      return mockQuery({ data: null });
    });
    return captured;
  }

  function kybKeysOf(payloads: Record<string, unknown>[]): string[] {
    return payloads.flatMap((p) => Object.keys(p).filter((k) => k.startsWith('kyb_')));
  }

  it('confirm-domain full verification (EIN present) grants VERIFIED without any kyb_* column', async () => {
    const updates = captureOrgUpdates({
      domain_verification_token: '123456:abcdef',
      domain_verification_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      ein_tax_id: '12-3456789',
      domain_verified: false,
      // Provider-KYB state present on the row on purpose: a future conditional
      // "carry-forward" stamp (`...(org.kyb_provider ? { kyb_… } : {})`) must
      // fire under this fixture so the ratchet catches it.
      kyb_provider: 'middesk',
      kyb_submitted_at: new Date(Date.now() - 3600_000).toISOString(),
    });

    const res = await request(app).post('/org/confirm-domain').send({ code: '123456' });
    expect(res.status).toBe(200);

    // The self-grant itself must have happened (otherwise this suite is
    // vacuously green against a rewritten handler that stopped writing).
    const grant = updates.find((p) => p.verification_status === 'VERIFIED');
    expect(grant).toBeDefined();
    expect(kybKeysOf(updates)).toEqual([]);
  });

  it('confirm-domain partial verification (no EIN) writes no kyb_* column', async () => {
    const updates = captureOrgUpdates({
      domain_verification_token: '123456:abcdef',
      domain_verification_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      ein_tax_id: null,
      domain_verified: false,
    });

    const res = await request(app).post('/org/confirm-domain').send({ code: '123456' });
    expect(res.status).toBe(200);
    expect(updates.length).toBeGreaterThan(0);
    expect(kybKeysOf(updates)).toEqual([]);
  });

  it('verify-domain token write stamps no kyb_* column', async () => {
    // The 4th update site in this file — the token write that starts domain
    // verification. `kyb_submitted_at` is the realistic bad stamp here ("record
    // when self-serve verification started"), so this route must be pinned too.
    const updates = captureOrgUpdates({ domain: 'example.com', domain_verified: false });

    const res = await request(app).post('/org/verify-domain').send({});
    expect(res.status).toBe(200);
    const tokenWrite = updates.find((p) => 'domain_verification_token' in p);
    expect(tokenWrite).toBeDefined();
    expect(kybKeysOf(updates)).toEqual([]);
  });

  it('verify-ein PENDING write stamps no kyb_* column', async () => {
    // organizations is hit twice: duplicate-EIN check (maybeSingle → null), then update.
    const updates = captureOrgUpdates(null);

    const res = await request(app).post('/org/verify-ein').send({ ein: '12-3456789' });
    expect(res.status).toBe(200);
    const pending = updates.find((p) => p.verification_status === 'PENDING');
    expect(pending).toBeDefined();
    expect(kybKeysOf(updates)).toEqual([]);
  });

  it('dev-verify grants VERIFIED without any kyb_* column', async () => {
    const updates = captureOrgUpdates(null);

    const res = await request(app).post('/org/dev-verify').send({});
    expect(res.status).toBe(200);
    const grant = updates.find((p) => p.verification_status === 'VERIFIED');
    expect(grant).toBeDefined();
    expect(kybKeysOf(updates)).toEqual([]);
  });
});

// ─── ORG_ADMIN gate (self-serve verification routes, 2026-08-12) ───

/**
 * The three self-serve verification writers (verify-ein, verify-domain,
 * confirm-domain) are ORG_ADMIN-gated: submitting a legal identifier and
 * driving the org toward the VERIFIED grant is a significant, org-level
 * action — the same rationale org-kyb.ts states for its ORG_ADMIN gate on
 * the analogous Middesk submission. Follows the _org-auth.ts precedence
 * (org_members owner/admin → profile ORG_ADMIN of THIS org → platform
 * admin) and its 500-vs-403 error split: an operational failure during the
 * admin lookup must surface as 500, never masquerade as a 403.
 *
 * GET /verification-status stays member-level (read-only, no PII in the
 * response); POST /dev-verify stays as-is (isDev-gated, unreachable in prod).
 */
describe('ORG_ADMIN gate — self-serve verification routes', () => {
  const app = createApp('user-123');

  function setupGateMocks(opts: {
    memberRow?: { role: string } | null;
    memberError?: unknown;
    profileRole?: string | null;
    platformAdmin?: boolean;
  }) {
    const tablesTouched: string[] = [];
    mockFrom.mockImplementation((table: string) => {
      tablesTouched.push(table);
      if (table === 'profiles') {
        return mockQuery({
          data: {
            org_id: 'org-abc',
            role: opts.profileRole ?? null,
            is_platform_admin: opts.platformAdmin ?? false,
          },
        });
      }
      if (table === 'org_members') {
        return mockQuery({ data: opts.memberRow ?? null, error: opts.memberError ?? null });
      }
      if (table === 'organizations') {
        // Benign default for the admin-success paths: duplicate-check misses,
        // selects return a workable org row, updates succeed.
        return mockQuery({ data: null, error: null });
      }
      return mockQuery({ data: null });
    });
    return tablesTouched;
  }

  const GATED_ROUTES = [
    { path: '/org/verify-ein', body: { ein: '12-3456789' } },
    { path: '/org/verify-domain', body: {} },
    { path: '/org/confirm-domain', body: { code: '123456' } },
  ] as const;

  it.each(GATED_ROUTES)('returns 403 for a plain org member on POST $path', async ({ path, body }) => {
    const tablesTouched = setupGateMocks({ memberRow: { role: 'member' }, profileRole: 'ORG_MEMBER' });
    const res = await request(app).post(path).send(body);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('admin');
    // The gate must sit BEFORE any organizations read/write.
    expect(tablesTouched).not.toContain('organizations');
  });

  it('grants via org_members role admin (verify-ein 200, no profile-role needed)', async () => {
    setupGateMocks({ memberRow: { role: 'admin' }, profileRole: null });
    const res = await request(app).post('/org/verify-ein').send({ ein: '12-3456789' });
    expect(res.status).toBe(200);
  });

  it('grants via profile ORG_ADMIN fallback when no org_members row exists', async () => {
    setupGateMocks({ memberRow: null, profileRole: 'ORG_ADMIN' });
    const res = await request(app).post('/org/verify-ein').send({ ein: '12-3456789' });
    expect(res.status).toBe(200);
  });

  it('grants via platform admin', async () => {
    setupGateMocks({ memberRow: null, profileRole: null, platformAdmin: true });
    const res = await request(app).post('/org/verify-ein').send({ ein: '12-3456789' });
    expect(res.status).toBe(200);
  });

  it('returns 500 (not 403) when the admin lookup hits a DB error', async () => {
    setupGateMocks({ memberError: { message: 'db down' }, profileRole: 'ORG_MEMBER' });
    const res = await request(app).post('/org/verify-ein').send({ ein: '12-3456789' });
    expect(res.status).toBe(500);
  });

  it('dev-verify stays member-level (not admin-gated)', async () => {
    setupGateMocks({ memberRow: { role: 'member' }, profileRole: 'ORG_MEMBER' });
    const res = await request(app).post('/org/dev-verify').send({});
    expect(res.status).toBe(200);
  });

  it('verification-status stays member-level (not admin-gated)', async () => {
    const tablesTouched: string[] = [];
    mockFrom.mockImplementation((table: string) => {
      tablesTouched.push(table);
      if (table === 'profiles') {
        return mockQuery({ data: { org_id: 'org-abc', role: 'ORG_MEMBER', is_platform_admin: false } });
      }
      if (table === 'org_members') {
        return mockQuery({ data: { role: 'member' } });
      }
      if (table === 'organizations') {
        return mockQuery({
          data: {
            verification_status: 'PENDING',
            domain: 'example.com',
            domain_verified: false,
            domain_verification_method: null,
            domain_verified_at: null,
            ein_tax_id: null,
          },
        });
      }
      return mockQuery({ data: null });
    });
    const res = await request(app).get('/org/verification-status');
    expect(res.status).toBe(200);
    expect(res.body.verificationStatus).toBe('PENDING');
  });
});
