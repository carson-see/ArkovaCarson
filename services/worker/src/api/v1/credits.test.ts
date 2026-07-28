/**
 * API Credit System Tests (PAY-01 / SCRUM-442)
 *
 * TDD: Tests for credit pack purchase and balance endpoints.
 * Constitution 1.7: No real Stripe calls — mock everything.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';

vi.mock('../../utils/db.js', () => ({
  db: {
    rpc: vi.fn(),
    from: vi.fn(),
  },
}));

vi.mock('../../config.js', () => ({
  config: {
    stripeSecretKey: '',
    frontendUrl: 'http://localhost:5173',
    corsAllowedOrigins: '',
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

vi.mock('../_org-auth.js', () => ({
  getCallerOrgId: vi.fn(),
}));

import { db } from '../../utils/db.js';
import { getCallerOrgId } from '../_org-auth.js';
import { creditsRouter, CREDIT_PACKS } from './credits.js';

/**
 * Mirrors the REAL production mount (services/worker/src/api/v1/router.ts:
 * `router.use('/credits', requireAuth, creditsRateLimiter, creditsRouter)`),
 * whose `requireAuth` sets `req.authUserId` — NOT `req.userId`/`req.orgId`
 * (that pair is set by a DIFFERENT `requireAuth` in
 * services/worker/src/routes/middleware.ts, used by non-v1 routes only).
 * Injecting `req.authUserId` here is what makes this test suite catch the
 * field-name mismatch bug: the old helper injected `req.userId`/`req.orgId`,
 * which credits.ts's old handlers read directly — so every test here passed
 * even though the real v1-mounted endpoint 401'd on every request.
 */
function createApp(userId?: string) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (userId) req.authUserId = userId;
    next();
  });
  app.use('/api/v1/credits', creditsRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/credits', () => {
  // ─── Endpoint-reachability regression: field-name mismatch ───
  // Before the fix, this handler read `req.userId`/`req.orgId`, which the
  // real v1 mount never populates (it sets `req.authUserId` via its own
  // local `requireAuth`). `createApp()` above injects `req.authUserId` —
  // exactly what production does — so this test is RED on the pre-fix code
  // (401) and GREEN after (200). This is the "authenticated caller gets 200,
  // not 401" proof.
  it('lets an authenticated caller (req.authUserId, matching the real v1 mount) through — not a 401', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');
    (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { monthly_allocation: 1000, used_this_month: 50, remaining: 950 },
      error: null,
    });

    const app = createApp('user-1');
    const res = await request(app).get('/api/v1/credits');

    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(950);
    expect(res.body.monthly_allocation).toBe(1000);
    expect(res.body.used_this_month).toBe(50);
    expect(res.body.packs).toHaveLength(4);
    expect(db.rpc).toHaveBeenCalledWith('check_unified_credits', {
      p_org_id: 'org-1',
      p_user_id: 'user-1',
    });
  });

  it('401s when unauthenticated (no req.authUserId)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/credits');
    expect(res.status).toBe(401);
  });

  it('resolves org id from the caller profile, not a client-supplied header (no cross-org read)', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');
    (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null, error: null });

    const app = createApp('user-1');
    await request(app).get('/api/v1/credits');

    expect(getCallerOrgId).toHaveBeenCalledWith('user-1');
  });

  it('returns 500 on DB error', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');
    (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null, error: { message: 'fail' } });

    const app = createApp('user-1');
    const res = await request(app).get('/api/v1/credits');
    expect(res.status).toBe(500);
  });
});

describe('POST /api/v1/credits/purchase', () => {
  it('401s when unauthenticated (no req.authUserId)', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/credits/purchase')
      .send({ pack_id: 'pack_1k' });
    expect(res.status).toBe(401);
  });

  it('validates pack_id', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');
    const app = createApp('user-1');
    const res = await request(app)
      .post('/api/v1/credits/purchase')
      .send({ pack_id: 'invalid' });

    expect(res.status).toBe(400);
    expect(res.body.valid_packs).toBeDefined();
  });

  it('grants credits in dev mode (no Stripe key)', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');
    (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null, error: null });

    const app = createApp('user-1');
    const res = await request(app)
      .post('/api/v1/credits/purchase')
      .send({ pack_id: 'pack_1k' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.credits_added).toBe(1000);
    expect(res.body.mode).toBe('development');
  });

  it('calls deduct_unified_credits with negative amount (grant)', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');
    (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null, error: null });

    const app = createApp('user-1');
    await request(app)
      .post('/api/v1/credits/purchase')
      .send({ pack_id: 'pack_10k' });

    expect(db.rpc).toHaveBeenCalledWith('deduct_unified_credits', {
      p_org_id: 'org-1',
      p_user_id: 'user-1',
      p_amount: -10000,
    });
  });
});

describe('GET /api/v1/credits/packs', () => {
  it('lists all credit packs', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/credits/packs');

    expect(res.status).toBe(200);
    expect(res.body.packs).toHaveLength(4);
    expect(res.body.packs[0].id).toBe('pack_1k');
    expect(res.body.packs[3].id).toBe('pack_1m');
  });
});

// ─── Static guard: field-name regression (endpoint-reachability audit) ───
// TypeScript did not catch this bug because `req.userId`/`req.orgId` are
// both LEGITIMATE optional properties on the global Express.Request
// augmentation (declared for OTHER middleware: `req.userId` by
// services/worker/src/routes/middleware.ts's requireAuth, `req.orgId` by
// services/worker/src/middleware/requireOrgId.ts) — so referencing them here
// type-checks fine regardless of whether THIS router's actual mount ever
// populates them. A locally-redeclared `interface AuthenticatedRequest`
// shadowing the same field names made this look type-safe without adding
// any real guarantee. There is no general compiler mechanism that ties "the
// middleware chain in front of this router" to "the fields this handler may
// read," so the durable fix is: (1) use the field the v1 mount ACTUALLY
// populates (`req.authUserId`), and (2) pin that choice with a source guard
// so a future edit can't silently reintroduce the mismatch.
describe('credits.ts field-name guard', () => {
  it('never reads req.userId / req.orgId — the v1 mount only populates req.authUserId', () => {
    const source = readFileSync(new URL('./credits.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\breq\.userId\b/);
    expect(source).not.toMatch(/\breq\.orgId\b/);
    expect(source).not.toMatch(/\bauthReq\.userId\b/);
    expect(source).not.toMatch(/\bauthReq\.orgId\b/);
    expect(source).toContain('req.authUserId');
  });
});

describe('CREDIT_PACKS', () => {
  it('has correct pack definitions', () => {
    expect(CREDIT_PACKS).toHaveLength(4);
    expect(CREDIT_PACKS[0]).toMatchObject({ id: 'pack_1k', credits: 1000, price_usd: 10 });
    expect(CREDIT_PACKS[1]).toMatchObject({ id: 'pack_10k', credits: 10000, price_usd: 80 });
    expect(CREDIT_PACKS[2]).toMatchObject({ id: 'pack_100k', credits: 100000, price_usd: 500 });
    expect(CREDIT_PACKS[3]).toMatchObject({ id: 'pack_1m', credits: 1000000, price_usd: 3000 });
  });
});
