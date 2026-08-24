/**
 * Unit tests for rate limiter middleware
 *
 * HARDENING-5: Window management, limit enforcement, headers, skipFailedRequests.
 *
 * NOTE: The module-level rateLimitStore Map persists across tests.
 * Each test uses unique IP+path combos to avoid cross-test contamination.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock logger before importing rateLimit (which imports logger at module level)
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { rateLimit, rateLimiters, cleanupExpiredEntries } from './rateLimit.js';

let testCounter = 0;

function createMockReqRes(ip?: string, path?: string) {
  const uniqueId = ++testCounter;
  const req = {
    ip: ip ?? `10.${Math.floor(uniqueId / 256)}.${uniqueId % 256}.1`,
    path: path ?? `/test-${uniqueId}`,
    headers: {},
  } as unknown as import('express').Request;
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  } as unknown as import('express').Response & Record<string, ReturnType<typeof vi.fn>>;
  const next = vi.fn();
  return { req, res, next };
}

/** Create req/res with a specific key (ip+path) for multi-request tests */
function createMockReqResWithKey(ip: string, path: string) {
  const req = { ip, path, headers: {} } as unknown as import('express').Request;
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  } as unknown as import('express').Response & Record<string, ReturnType<typeof vi.fn>>;
  const next = vi.fn();
  return { req, res, next };
}

describe('rateLimit', () => {
  describe('basic limit enforcement', () => {
    it('allows requests under the limit', () => {
      const limiter = rateLimit({ windowMs: 60000, maxRequests: 3 });
      const { req, res, next } = createMockReqRes();

      limiter(req, res, next);
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('blocks requests at the limit with 429', () => {
      const limiter = rateLimit({ windowMs: 60000, maxRequests: 2 });
      const ip = '192.168.1.1';
      const path = '/block-test';

      // First two requests pass
      for (let i = 0; i < 2; i++) {
        const { req, res, next } = createMockReqResWithKey(ip, path);
        limiter(req, res, next);
        expect(next).toHaveBeenCalled();
      }

      // Third request blocked
      const { req, res, next } = createMockReqResWithKey(ip, path);
      limiter(req, res, next);
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Too many requests' })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('resets count after window expires', () => {
      vi.useFakeTimers();
      const limiter = rateLimit({ windowMs: 1000, maxRequests: 1 });
      const ip = '192.168.2.1';
      const path = '/window-test';

      // First request passes
      const { req: req1, res: res1, next: next1 } = createMockReqResWithKey(ip, path);
      limiter(req1, res1, next1);
      expect(next1).toHaveBeenCalled();

      // Second request blocked
      const { req: req2, res: res2, next: next2 } = createMockReqResWithKey(ip, path);
      limiter(req2, res2, next2);
      expect(res2.status).toHaveBeenCalledWith(429);

      // Advance past window
      vi.advanceTimersByTime(1001);

      // Third request passes (new window)
      const { req: req3, res: res3, next: next3 } = createMockReqResWithKey(ip, path);
      limiter(req3, res3, next3);
      expect(next3).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('rate limit headers', () => {
    it('sets X-RateLimit-Limit header on every request', () => {
      const limiter = rateLimit({ windowMs: 60000, maxRequests: 10 });
      const { req, res, next } = createMockReqRes();

      limiter(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '10');
    });

    it('sets X-RateLimit-Remaining header with correct countdown', () => {
      const limiter = rateLimit({ windowMs: 60000, maxRequests: 5 });
      const ip = '192.168.3.1';
      const path = '/remaining-test';

      // First request
      const { req: req1, res: res1, next: next1 } = createMockReqResWithKey(ip, path);
      limiter(req1, res1, next1);
      expect(res1.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '4');

      // Second request
      const { req: req2, res: res2, next: next2 } = createMockReqResWithKey(ip, path);
      limiter(req2, res2, next2);
      expect(res2.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '3');
    });

    it('sets Retry-After header on 429 response', () => {
      const limiter = rateLimit({ windowMs: 60000, maxRequests: 1 });
      const ip = '192.168.4.1';
      const path = '/retry-after-test';

      // Exhaust limit
      const { req: req1, res: res1, next: next1 } = createMockReqResWithKey(ip, path);
      limiter(req1, res1, next1);

      // Blocked request
      const { req, res, next } = createMockReqResWithKey(ip, path);
      limiter(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith(
        'Retry-After',
        expect.stringMatching(/^\d+$/)
      );
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '0');
    });
  });

  describe('key generation', () => {
    it('separates limits by IP (default keyGenerator)', () => {
      const limiter = rateLimit({ windowMs: 60000, maxRequests: 1 });

      // IP A passes
      const { req: reqA, res: resA, next: nextA } = createMockReqResWithKey('10.1.0.1', '/ip-test');
      limiter(reqA, resA, nextA);
      expect(nextA).toHaveBeenCalled();

      // IP B also passes (separate bucket)
      const { req: reqB, res: resB, next: nextB } = createMockReqResWithKey('10.1.0.2', '/ip-test');
      limiter(reqB, resB, nextB);
      expect(nextB).toHaveBeenCalled();
    });

    it('uses custom keyGenerator when provided', () => {
      const limiter = rateLimit({
        windowMs: 60000,
        maxRequests: 1,
        keyGenerator: () => 'global-key-test',
      });

      // First request passes
      const { req: req1, res: res1, next: next1 } = createMockReqResWithKey('10.2.0.1', '/custom-key');
      limiter(req1, res1, next1);
      expect(next1).toHaveBeenCalled();

      // Second request blocked (same global key, different IP)
      const { req: req2, res: res2, next: next2 } = createMockReqResWithKey('10.2.0.2', '/custom-key');
      limiter(req2, res2, next2);
      expect(res2.status).toHaveBeenCalledWith(429);
    });

    // 2026-04-26 — bug-bounty F5 regression. The previous behavior keyed
    // buckets on `${req.path}:${keyGenerator(req)}`, which meant
    // `/verify/ABC` and `/verify/XYZ` got separate buckets. That defeated
    // Constitution 1.10's "100 req/min per IP" intent for endpoints with
    // a path parameter (the public verify endpoint). Buckets now key on
    // `keyGenerator(req)` (default: req.ip) only — paths share a bucket
    // per IP. Use the `scope` option to opt back into separate buckets
    // when you genuinely want per-feature isolation (e.g. batch).
    it('shares one bucket per IP across paths (Constitution 1.10)', () => {
      const limiter = rateLimit({ windowMs: 60000, maxRequests: 1 });
      const ip = '10.3.0.1';

      // /path-a passes
      const { req: req1, res: res1, next: next1 } = createMockReqResWithKey(ip, '/unique-path-a');
      limiter(req1, res1, next1);
      expect(next1).toHaveBeenCalled();

      // /path-b is now blocked — same IP, max 1 req/window across all paths
      const { req: req2, res: res2, next: next2 } = createMockReqResWithKey(ip, '/unique-path-b');
      limiter(req2, res2, next2);
      expect(next2).not.toHaveBeenCalled();
      expect(res2.status).toHaveBeenCalledWith(429);
    });

    it('keeps separate buckets when limiters use different `scope` values', () => {
      const verifyLimiter = rateLimit({ windowMs: 60000, maxRequests: 1, scope: 'verify' });
      const batchLimiter = rateLimit({ windowMs: 60000, maxRequests: 1, scope: 'batch' });
      const ip = '10.4.0.1';

      const { req: rA, res: resA, next: nextA } = createMockReqResWithKey(ip, '/verify/x');
      verifyLimiter(rA, resA, nextA);
      expect(nextA).toHaveBeenCalled();

      // Same IP but different scope -> separate bucket, allowed
      const { req: rB, res: resB, next: nextB } = createMockReqResWithKey(ip, '/verify/batch');
      batchLimiter(rB, resB, nextB);
      expect(nextB).toHaveBeenCalled();

      // Reuse the verify bucket -> rate limited
      const { req: rC, res: resC, next: nextC } = createMockReqResWithKey(ip, '/verify/y');
      verifyLimiter(rC, resC, nextC);
      expect(nextC).not.toHaveBeenCalled();
      expect(resC.status).toHaveBeenCalledWith(429);
    });
  });

  // SCRUM-3418 — per-limiter default bucket scope. `scope` used to default to
  // '' and the bucket key was the bare keyGenerator output, so EVERY limiter
  // that kept the default `req.ip` keyGenerator read and wrote ONE shared Map
  // entry per IP: the 60/min IP guard, the 10/min checkout limiter, the 5/min
  // auth limiter and the 100/min v1 anon limiter. Two §1.10 violations fall
  // out of that and both are pinned here.
  describe('default bucket scope isolation (SCRUM-3418)', () => {
    it('gives two default-configured limiters separate buckets for the same IP', () => {
      const limiterA = rateLimit({ windowMs: 60000, maxRequests: 1 });
      const limiterB = rateLimit({ windowMs: 60000, maxRequests: 1 });
      const ip = '10.6.0.1';

      // Exhaust limiter A for this IP.
      const a1 = createMockReqResWithKey(ip, '/scope-iso-a');
      limiterA(a1.req, a1.res, a1.next);
      expect(a1.next).toHaveBeenCalled();

      const a2 = createMockReqResWithKey(ip, '/scope-iso-a');
      limiterA(a2.req, a2.res, a2.next);
      expect(a2.res.status).toHaveBeenCalledWith(429);

      // Limiter B owns its own budget for that IP — A exhausting its bucket
      // must not spend B's.
      const b1 = createMockReqResWithKey(ip, '/scope-iso-b');
      limiterB(b1.req, b1.res, b1.next);
      expect(b1.next).toHaveBeenCalled();
      expect(b1.res.status).not.toHaveBeenCalled();
    });

    it('stops a high-cap limiter from spending a low-cap limiter budget', () => {
      // The reported production symptom (SCRUM-3372): `rateLimiters.api`
      // (60/min) and `rateLimiters.checkout` (10/min) shared one per-IP entry,
      // so the checkout limiter logged `count: 60, maxRequests: 10` and 429'd
      // callers that had never touched a checkout route.
      const ip = '10.6.0.2';

      for (let i = 0; i < 10; i++) {
        const { req, res, next } = createMockReqResWithKey(ip, '/api/badge/ARK-X');
        rateLimiters.api(req, res, next);
        expect(next).toHaveBeenCalled();
      }

      const { req, res, next } = createMockReqResWithKey(ip, '/api/checkout/session');
      rateLimiters.checkout(req, res, next);
      expect(res.status).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    it('leaves the 100/min anon budget intact after a 60/min IP guard ran on the same IP', () => {
      // §1.10 gives anonymous callers 100 req/min. With one shared per-IP
      // entry the 60/min IP guard's counter WAS the anon limiter's counter, so
      // the anon limiter could never enforce its own contract.
      const ipGuard = rateLimit({ windowMs: 60000, maxRequests: 60 });
      const anon = rateLimit({ windowMs: 60000, maxRequests: 100 });
      const ip = '10.6.0.3';

      // Spend the IP guard's bucket exactly.
      for (let i = 0; i < 60; i++) {
        const { req, res, next } = createMockReqResWithKey(ip, '/api/badge/ARK-X');
        ipGuard(req, res, next);
        expect(next).toHaveBeenCalled();
      }

      // The anon limiter still owes this IP its full 100.
      for (let i = 0; i < 100; i++) {
        const { req, res, next } = createMockReqResWithKey(ip, '/api/v1/verify/ARK-X');
        anon(req, res, next);
        expect(next, `anon request ${i + 1} of 100 must be allowed (\u00a71.10)`).toHaveBeenCalled();
      }

      // 101 is the first rejection, and it advertises the anon contract.
      const over = createMockReqResWithKey(ip, '/api/v1/verify/ARK-X');
      anon(over.req, over.res, over.next);
      expect(over.res.status).toHaveBeenCalledWith(429);
      expect(over.res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '100');
    });

    it('isolates two limiters that share identical windowMs/maxRequests', () => {
      // Guards against a default scope derived from the limiter's CONFIG:
      // checkout and quotaCheck are both 10 req / 60_000 ms and must still
      // hold separate buckets.
      const ip = '10.6.0.4';

      for (let i = 0; i < 10; i++) {
        const { req, res, next } = createMockReqResWithKey(ip, '/api/checkout/session');
        rateLimiters.checkout(req, res, next);
        expect(next).toHaveBeenCalled();
      }

      const { req, res, next } = createMockReqResWithKey(ip, '/api/v1/quota');
      rateLimiters.quotaCheck(req, res, next);
      expect(res.status).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    it('still lets an explicit scope name the bucket', () => {
      // Explicit scopes remain the way to give a limiter a stable, readable
      // bucket name; the auto-assigned default is only the collision floor.
      const scoped = rateLimit({ windowMs: 60000, maxRequests: 1, scope: 'explicit-scope-test' });
      const ip = '10.6.0.5';

      const first = createMockReqResWithKey(ip, '/explicit-a');
      scoped(first.req, first.res, first.next);
      expect(first.next).toHaveBeenCalled();

      const second = createMockReqResWithKey(ip, '/explicit-b');
      scoped(second.req, second.res, second.next);
      expect(second.res.status).toHaveBeenCalledWith(429);
    });
  });

  describe('skip predicate (F-2)', () => {
    it('bypasses the limiter entirely when skip returns true', () => {
      const limiter = rateLimit({ windowMs: 60000, maxRequests: 1, skip: () => true });
      const ip = '10.5.0.1';
      const path = '/skip-test';

      // Would normally block on the 2nd request (maxRequests: 1) — skip
      // means neither request is ever counted.
      for (let i = 0; i < 5; i++) {
        const { req, res, next } = createMockReqResWithKey(ip, path);
        limiter(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
        expect(res.setHeader).not.toHaveBeenCalled();
      }
    });

    it('enforces the limiter normally when skip returns false', () => {
      const limiter = rateLimit({ windowMs: 60000, maxRequests: 1, skip: () => false });
      const ip = '10.5.0.2';
      const path = '/no-skip-test';

      const first = createMockReqResWithKey(ip, path);
      limiter(first.req, first.res, first.next);
      expect(first.next).toHaveBeenCalled();

      const second = createMockReqResWithKey(ip, path);
      limiter(second.req, second.res, second.next);
      expect(second.res.status).toHaveBeenCalledWith(429);
    });

    it('evaluates skip per-request based on req contents (keyed vs anon)', () => {
      // Mirrors the F-2 fix: skip for requests carrying an API key credential.
      const hasApiKey = (req: import('express').Request) =>
        typeof req.headers.authorization === 'string' &&
        req.headers.authorization.startsWith('Bearer ak_');
      const limiter = rateLimit({ windowMs: 60000, maxRequests: 1, skip: hasApiKey });
      const ip = '10.5.0.3';
      const path = '/keyed-vs-anon';

      // Keyed requests: unlimited by THIS limiter, however many we send.
      for (let i = 0; i < 5; i++) {
        const req = {
          ip,
          path,
          headers: { authorization: 'Bearer ak_live_testkey' },
        } as unknown as import('express').Request;
        const res = {
          statusCode: 200,
          setHeader: vi.fn(),
          status: vi.fn().mockReturnThis(),
          json: vi.fn().mockReturnThis(),
          send: vi.fn().mockReturnThis(),
        } as unknown as import('express').Response;
        const next = vi.fn();
        limiter(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      }

      // Anon request on the same IP+path: still gated at maxRequests: 1.
      const anon1 = createMockReqResWithKey(ip, path);
      limiter(anon1.req, anon1.res, anon1.next);
      expect(anon1.next).toHaveBeenCalled();

      const anon2 = createMockReqResWithKey(ip, path);
      limiter(anon2.req, anon2.res, anon2.next);
      expect(anon2.res.status).toHaveBeenCalledWith(429);
    });
  });

  describe('skipFailedRequests', () => {
    it('decrements count for 4xx/5xx responses when enabled', () => {
      const limiter = rateLimit({
        windowMs: 60000,
        maxRequests: 2,
        skipFailedRequests: true,
      });
      const ip = '192.168.5.1';
      const path = '/skip-fail-test';

      // First request — will fail with 500
      const { req: req1, res: res1, next: next1 } = createMockReqResWithKey(ip, path);
      limiter(req1, res1, next1);
      res1.statusCode = 500;
      res1.send('error'); // triggers count decrement

      // Second request should still pass (failed request didn't count)
      const { req: req2, res: res2, next: next2 } = createMockReqResWithKey(ip, path);
      limiter(req2, res2, next2);
      expect(next2).toHaveBeenCalled();

      // Third request should still pass (only 1 successful counted so far)
      const { req: req3, res: res3, next: next3 } = createMockReqResWithKey(ip, path);
      limiter(req3, res3, next3);
      expect(next3).toHaveBeenCalled();
    });

    it('does not decrement for successful responses', () => {
      const limiter = rateLimit({
        windowMs: 60000,
        maxRequests: 1,
        skipFailedRequests: true,
      });
      const ip = '192.168.6.1';
      const path = '/skip-success-test';

      // First request — succeeds with 200
      const { req: req1, res: res1, next: next1 } = createMockReqResWithKey(ip, path);
      limiter(req1, res1, next1);
      res1.statusCode = 200;
      res1.send('ok'); // no decrement

      // Second request blocked (successful request counted)
      const { req: req2, res: res2, next: next2 } = createMockReqResWithKey(ip, path);
      limiter(req2, res2, next2);
      expect(res2.status).toHaveBeenCalledWith(429);
    });
  });

  describe('cleanupExpiredEntries', () => {
    it('removes expired entries from the store', () => {
      vi.useFakeTimers({ now: 100000 });
      const limiter = rateLimit({ windowMs: 1000, maxRequests: 5 });
      const ip = '192.168.100.1';
      const path = '/cleanup-test';

      // Add an entry (expires at now + 1000ms = 101000)
      const { req, res, next } = createMockReqResWithKey(ip, path);
      limiter(req, res, next);
      expect(next).toHaveBeenCalled();

      // Advance past the window so entry is expired
      vi.advanceTimersByTime(1500);

      // Call cleanup directly
      cleanupExpiredEntries();

      // After cleanup, a new request should start fresh (count = 1, not 2)
      const { req: req2, res: res2, next: next2 } = createMockReqResWithKey(ip, path);
      limiter(req2, res2, next2);
      expect(next2).toHaveBeenCalled();
      expect(res2.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '4');

      vi.useRealTimers();
    });

    it('retains non-expired entries', () => {
      vi.useFakeTimers({ now: 200000 });
      const limiter = rateLimit({ windowMs: 60000, maxRequests: 5 });
      const ip = '192.168.101.1';
      const path = '/cleanup-retain';

      // Add an entry (expires at now + 60000)
      const { req, res, next } = createMockReqResWithKey(ip, path);
      limiter(req, res, next);

      // Cleanup — entry should NOT be removed (not expired)
      cleanupExpiredEntries();

      // Second request should see count = 2, remaining = 3
      const { req: req2, res: res2, next: next2 } = createMockReqResWithKey(ip, path);
      limiter(req2, res2, next2);
      expect(res2.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '3');

      vi.useRealTimers();
    });
  });

  describe('fallback key generation', () => {
    it('uses "unknown" when req.ip is undefined', () => {
      const limiter = rateLimit({ windowMs: 60000, maxRequests: 5 });
      const req = { ip: undefined, path: '/unknown-ip-test', headers: {} } as unknown as import('express').Request;
      const res = {
        statusCode: 200,
        setHeader: vi.fn(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
      } as unknown as import('express').Response & Record<string, ReturnType<typeof vi.fn>>;
      const next = vi.fn();

      limiter(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('pre-configured limiters', () => {
    it('exports stripeWebhook limiter', () => {
      expect(rateLimiters.stripeWebhook).toBeDefined();
      expect(typeof rateLimiters.stripeWebhook).toBe('function');
    });

    it('exports checkout limiter', () => {
      expect(rateLimiters.checkout).toBeDefined();
      expect(typeof rateLimiters.checkout).toBe('function');
    });

    it('exports api limiter', () => {
      expect(rateLimiters.api).toBeDefined();
      expect(typeof rateLimiters.api).toBe('function');
    });

    it('exports auth limiter', () => {
      expect(rateLimiters.auth).toBeDefined();
      expect(typeof rateLimiters.auth).toBe('function');
    });

    // DH-08: Quota check rate limiter
    it('exports quotaCheck limiter', () => {
      expect(rateLimiters.quotaCheck).toBeDefined();
      expect(typeof rateLimiters.quotaCheck).toBe('function');
    });

    it('quotaCheck limiter allows 10 requests per minute', () => {
      const ip = '192.168.200.1';
      const path = '/quota-check-test';

      // First 10 requests should pass
      for (let i = 0; i < 10; i++) {
        const { req, res, next } = createMockReqResWithKey(ip, path);
        rateLimiters.quotaCheck(req, res, next);
        expect(next).toHaveBeenCalled();
      }

      // 11th should be blocked
      const { req, res, next } = createMockReqResWithKey(ip, path);
      rateLimiters.quotaCheck(req, res, next);
      expect(res.status).toHaveBeenCalledWith(429);
    });
  });
});
