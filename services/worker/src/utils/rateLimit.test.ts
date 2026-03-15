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
  const req: any = {
    ip: ip ?? `10.${Math.floor(uniqueId / 256)}.${uniqueId % 256}.1`,
    path: path ?? `/test-${uniqueId}`,
    headers: {},
  };
  const res: any = {
    statusCode: 200,
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  const next = vi.fn();
  return { req, res, next };
}

/** Create req/res with a specific key (ip+path) for multi-request tests */
function createMockReqResWithKey(ip: string, path: string) {
  const req: any = { ip, path, headers: {} };
  const res: any = {
    statusCode: 200,
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
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

    it('separates limits by path', () => {
      const limiter = rateLimit({ windowMs: 60000, maxRequests: 1 });
      const ip = '10.3.0.1';

      // /path-a passes
      const { req: req1, res: res1, next: next1 } = createMockReqResWithKey(ip, '/unique-path-a');
      limiter(req1, res1, next1);
      expect(next1).toHaveBeenCalled();

      // /path-b also passes (different path key)
      const { req: req2, res: res2, next: next2 } = createMockReqResWithKey(ip, '/unique-path-b');
      limiter(req2, res2, next2);
      expect(next2).toHaveBeenCalled();
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
      const req: any = { ip: undefined, path: '/unknown-ip-test', headers: {} };
      const res: any = {
        statusCode: 200,
        setHeader: vi.fn(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
      };
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
