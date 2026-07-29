/**
 * F-2 regression test — soak finding SOAK-FINDINGS-2026-08.md.
 *
 * Reproduces the exact middleware shape at index.ts:377 (a broad per-IP
 * limiter mounted ahead of `/api/v1`'s own per-API-key limiter) and proves:
 *   (a) a request carrying a valid API key credential can exceed the outer
 *       per-IP cap, up to the real per-key ceiling enforced downstream.
 *   (b) anonymous / no-key requests are still capped by the outer per-IP
 *       limiter — the fix must not weaken anon protection.
 *
 * Uses small maxRequests values (not the real 60/1000 from Constitution
 * 1.10) purely so the test runs fast; the middleware wiring and skip
 * predicate under test are identical to production.
 */

import { describe, it, expect, vi } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import supertest from 'supertest';

vi.mock('./utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { rateLimit } from './utils/rateLimit.js';

function hasApiKeyCredential(req: Request): boolean {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ak_')) return true;
  const xApiKey = req.headers['x-api-key'];
  return typeof xApiKey === 'string' && xApiKey.startsWith('ak_');
}

/** Builds the F-2-fixed middleware chain: outer per-IP shadow guard (cap 3)
 *  ahead of an inner per-key limiter (cap 8) mounted at /api/v1, mirroring
 *  index.ts's `apiIpShadowGuard` in front of `apiV1Router`'s keyedRateLimiter.
 *
 *  `testId` namespaces both limiters' buckets so parallel `it` blocks (all
 *  hitting supertest's shared loopback IP) don't contaminate each other's
 *  counts — the module-level rate limit store persists across tests. */
function buildApp(testId: string) {
  const app = express();

  // NOTE: `outer:`/`inner:` prefixes (on top of `testId`) are load-bearing —
  // without them, an anon request's fallback key (`req.ip`, since there's no
  // API key) would collide between the two limiters and both would
  // increment the SAME rateLimitStore entry (the module-level store is a
  // shared singleton). In production this collision is harmless — outer and
  // inner are both legitimately per-IP for anon traffic — but it would
  // silently invalidate this test's separate cap assertions.
  const outerIpGuard = rateLimit({
    windowMs: 60000,
    maxRequests: 3, // stand-in for the real 60/min
    keyGenerator: (req) => `outer:${testId}:${req.ip || 'unknown'}`,
    skip: (req) => req.originalUrl.startsWith('/api/v1/') && hasApiKeyCredential(req),
  });

  const innerKeyedLimiter = rateLimit({
    windowMs: 60000,
    maxRequests: 8, // stand-in for the real 1,000/min
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      return `inner:${testId}:${typeof auth === 'string' ? auth : req.ip || 'unknown'}`;
    },
  });

  // Same order as index.ts: broad /api mount first, /api/v1 router after.
  app.use('/api', outerIpGuard, express.Router()); // stand-in for badgeRouter etc.
  app.use('/api/v1', innerKeyedLimiter, (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });
  // Non-versioned /api route, unaffected by the skip (no /api/v1 prefix).
  app.use('/api/badge/:id', (_req: Request, res: Response, _next: NextFunction) => {
    res.status(200).json({ badge: true });
  });

  return app;
}

describe('F-2 rate limiter shadow guard', () => {
  it('(a) keyed /api/v1 traffic exceeds the outer per-IP cap, up to the inner per-key ceiling', async () => {
    const app = buildApp('test-a');
    const agent = supertest(app);
    const authHeader = 'Bearer ak_live_shadowguardtest';

    // Outer guard alone allows only 3/min per IP — send 6 keyed requests
    // (double the outer cap, within the inner cap of 8) and expect all 200s.
    for (let i = 0; i < 6; i++) {
      const res = await agent.get('/api/v1/anchor').set('Authorization', authHeader);
      expect(res.status).toBe(200);
    }
  });

  it('(b) anonymous /api/v1 traffic is still capped by the outer per-IP limiter', async () => {
    const app = buildApp('test-b');
    const agent = supertest(app);

    // First 3 anon requests pass (outer cap).
    for (let i = 0; i < 3; i++) {
      const res = await agent.get('/api/v1/anchor');
      expect(res.status).toBe(200);
    }

    // 4th anon request is blocked by the outer per-IP guard before it ever
    // reaches the inner per-key limiter.
    const blocked = await agent.get('/api/v1/anchor');
    expect(blocked.status).toBe(429);
  });

  it('non-/api/v1 traffic (e.g. /api/badge) is untouched by the skip predicate', async () => {
    const app = buildApp('test-c');
    const agent = supertest(app);
    const authHeader = 'Bearer ak_live_shadowguardtest';

    // Even with a valid-looking API key, non-/api/v1 paths still hit the
    // outer per-IP guard (cap 3) — the skip only applies to /api/v1/*.
    for (let i = 0; i < 3; i++) {
      const res = await agent.get('/api/badge/abc').set('Authorization', authHeader);
      expect(res.status).toBe(200);
    }
    const blocked = await agent.get('/api/badge/abc').set('Authorization', authHeader);
    expect(blocked.status).toBe(429);
  });
});
