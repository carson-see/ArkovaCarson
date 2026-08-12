/**
 * Double-mount regression test — `apiIpShadowGuard` counted one request twice.
 *
 * `services/worker/src/index.ts` mounts the SAME limiter instance twice:
 *
 *   index.ts:418   app.use('/api', apiIpShadowGuard, badgeRouter);
 *   index.ts:446   app.use(apiIpShadowGuard, didWebRouter);   <- no path prefix
 *
 * Both mounts are deliberate and load-bearing. The unprefixed one exists
 * because `didWebRouter` serves `/.well-known/did.json` and `/orgs/:id/did.json`,
 * which are NOT under `/api`, and it must carry the same skip predicate or it
 * re-shadows apiV1Router's per-key limiter (F-2, PR #1768 / 6f844d484). So the
 * fix is NOT to delete a mount — it is that one request counts once.
 *
 * The failure is path-dependent, which is why it hid for so long:
 *
 *   /api/badge/:id      -> mount 418 runs the guard, badgeRouter RESPONDS.
 *                          Chain ends before 446. Counted once. Looks fine.
 *   /api/v1/... (anon)  -> mount 418 runs the guard, badgeRouter does not
 *                          match and calls next(); nothing else under /api
 *                          handles it either, so the request reaches the
 *                          unprefixed mount at 446 and the SAME guard runs a
 *                          SECOND time. Counted twice.
 *
 * Net: the documented 60 req/min per IP (Constitution §1.10) is really 30/min
 * for the anonymous traffic that falls through. Observed on the
 * connector-sidecar side-rig 2026-08-12: `x-ratelimit-remaining` walked
 * 48 -> 46 -> 44, a stride of 2 per request, which one correctly-mounted
 * limiter cannot produce.
 *
 * NOTE this fix LOOSENS enforcement (30/min -> the intended 60/min). It is a
 * change in enforcement numbers, not a pure cleanup.
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import express, { Request } from 'express';
import supertest from 'supertest';

vi.mock('./utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { rateLimit, stopRateLimitCleanup } from './utils/rateLimit.js';

afterAll(() => {
  stopRateLimitCleanup();
});

function hasApiKeyCredential(req: Request): boolean {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ak_')) return true;
  const xApiKey = req.headers['x-api-key'];
  return typeof xApiKey === 'string' && xApiKey.startsWith('ak_');
}

/**
 * Reproduces index.ts's mount shape around the guard.
 *
 * `testId` namespaces the bucket: the rate-limit store is a module-level
 * singleton and every supertest request comes from the same loopback IP, so
 * without this, parallel `it` blocks contaminate each other's counts.
 */
function buildApp(testId: string, maxRequests: number) {
  const app = express();
  app.set('trust proxy', true);

  const guard = rateLimit({
    windowMs: 60_000,
    maxRequests,
    keyGenerator: (req) => `guard:${testId}:${req.ip || 'unknown'}`,
    skip: (req) => req.originalUrl.startsWith('/api/v1/') && hasApiKeyCredential(req),
  });

  // index.ts:418 — prefixed mount. Its router answers /api/badge/* and calls
  // next() for anything else under /api.
  const badgeRouter = express.Router();
  badgeRouter.get('/badge/:id', (_req, res) => {
    res.status(200).json({ router: 'badge' });
  });
  app.use('/api', guard, badgeRouter);

  // index.ts:446 — UNPREFIXED mount. Runs for every request that got this far,
  // including the /api/v1/* traffic that fell through above.
  const didWebRouter = express.Router();
  didWebRouter.get('/.well-known/did.json', (_req, res) => {
    res.status(200).json({ router: 'did-web' });
  });
  app.use(guard, didWebRouter);

  // Stands in for apiV1Router, registered after both mounts (as in index.ts).
  app.get('/api/v1/probe', (_req, res) => {
    res.status(200).json({ router: 'api-v1' });
  });

  return app;
}

const remaining = (res: { headers: Record<string, string> }) =>
  Number(res.headers['x-ratelimit-remaining']);

describe('apiIpShadowGuard double-mount', () => {
  it('counts a fall-through /api/v1 request ONCE, not twice', async () => {
    const app = buildApp('fallthrough', 10);

    const r1 = await supertest(app).get('/api/v1/probe').expect(200);
    const r2 = await supertest(app).get('/api/v1/probe').expect(200);
    const r3 = await supertest(app).get('/api/v1/probe').expect(200);

    // The side-rig signature was a stride of 2 (48 -> 46 -> 44).
    expect([remaining(r1), remaining(r2), remaining(r3)]).toEqual([9, 8, 7]);
  });

  it('admits the full documented allowance before refusing', async () => {
    const max = 6;
    const app = buildApp('allowance', max);

    for (let i = 0; i < max; i++) {
      await supertest(app).get('/api/v1/probe').expect(200);
    }
    // Double-counting made this 429 at max/2.
    await supertest(app).get('/api/v1/probe').expect(429);
  });

  it('still counts a request the prefixed mount answers (no regression)', async () => {
    const app = buildApp('badge', 10);

    const r1 = await supertest(app).get('/api/badge/abc').expect(200);
    const r2 = await supertest(app).get('/api/badge/abc').expect(200);

    // This path always counted once — it responds before reaching mount 446.
    expect([remaining(r1), remaining(r2)]).toEqual([9, 8]);
  });

  it('still counts a request only the unprefixed mount answers (did:web)', async () => {
    const app = buildApp('didweb', 10);

    const r1 = await supertest(app).get('/.well-known/did.json').expect(200);
    const r2 = await supertest(app).get('/.well-known/did.json').expect(200);

    // did:web must stay protected — the fix must not drop its bucket.
    expect([remaining(r1), remaining(r2)]).toEqual([9, 8]);
    expect(r1.body).toMatchObject({ router: 'did-web' });
  });

  it('keeps the skip predicate working — keyed /api/v1 traffic is counted by neither mount', async () => {
    const app = buildApp('keyed', 10);

    await supertest(app).get('/api/v1/probe').set('X-API-Key', 'ak_live_test').expect(200);
    const anon = await supertest(app).get('/api/v1/probe').expect(200);

    // The keyed request consumed nothing, so the anon request is the first count.
    expect(remaining(anon)).toBe(9);
  });

  it('does not suppress counting across separate requests', async () => {
    // The de-dupe must be scoped to one request, not leak into the next.
    const app = buildApp('per-request', 10);

    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      seen.push(remaining(await supertest(app).get('/api/v1/probe').expect(200)));
    }

    expect(seen).toEqual([9, 8, 7, 6]);
  });

  it('does not suppress counting by a DIFFERENT limiter instance sharing the key', async () => {
    // index.ts deliberately shares one per-IP bucket across limiter instances
    // (the F5 fix keys purely on scope + keyGenerator). De-duping must be
    // per-instance, or a second limiter silently stops enforcing.
    const app = express();
    app.set('trust proxy', true);
    const key = () => 'shared:two-instances';

    const first = rateLimit({ windowMs: 60_000, maxRequests: 10, keyGenerator: key });
    const second = rateLimit({ windowMs: 60_000, maxRequests: 10, keyGenerator: key });
    app.use(first);
    app.use(second);
    app.get('/probe', (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const res = await supertest(app).get('/probe').expect(200);

    // Two distinct limiters, one shared bucket: 2 counts, so remaining is 8.
    expect(remaining(res)).toBe(8);
  });
});
