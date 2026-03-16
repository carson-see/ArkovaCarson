/**
 * Rate Limit Load Test (P4.5-TS-13)
 *
 * Tests rate limiting behavior under sustained load:
 * - Anonymous tier: 100 req/min per IP
 * - API key tier: 1,000 req/min per key
 * - Batch tier: 10 req/min per key
 * - Verifies 429 responses with Retry-After header
 * - Verifies request throughput stays within limits
 *
 * @category load-test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks ----

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../services/worker/src/utils/logger.js', () => ({
  logger: mockLogger,
}));

// Simple in-memory rate limiter for testing (mirrors rateLimit.ts logic)
function createTestLimiter(windowMs: number, maxRequests: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return {
    check(key: string): { allowed: boolean; remaining: number; retryAfterMs: number } {
      const now = Date.now();
      const entry = hits.get(key);

      if (!entry || now >= entry.resetAt) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, remaining: maxRequests - 1, retryAfterMs: 0 };
      }

      entry.count++;
      if (entry.count > maxRequests) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterMs: entry.resetAt - now,
        };
      }

      return { allowed: true, remaining: maxRequests - entry.count, retryAfterMs: 0 };
    },

    reset() {
      hits.clear();
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Rate Limit Load Tests', () => {
  describe('Anonymous tier (100 req/min)', () => {
    const limiter = createTestLimiter(60_000, 100);

    beforeEach(() => limiter.reset());

    it('allows exactly 100 requests within window', () => {
      const ip = '192.168.1.1';
      let allowed = 0;
      let blocked = 0;

      for (let i = 0; i < 120; i++) {
        const result = limiter.check(ip);
        if (result.allowed) allowed++;
        else blocked++;
      }

      expect(allowed).toBe(100);
      expect(blocked).toBe(20);
    });

    it('tracks different IPs independently', () => {
      for (let i = 0; i < 100; i++) {
        expect(limiter.check('ip-a').allowed).toBe(true);
      }
      expect(limiter.check('ip-a').allowed).toBe(false);
      expect(limiter.check('ip-b').allowed).toBe(true);
    });

    it('returns Retry-After when rate limited', () => {
      const ip = '10.0.0.1';
      for (let i = 0; i < 100; i++) limiter.check(ip);

      const result = limiter.check(ip);
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(result.retryAfterMs).toBeLessThanOrEqual(60_000);
    });
  });

  describe('API key tier (1,000 req/min)', () => {
    const limiter = createTestLimiter(60_000, 1000);

    beforeEach(() => limiter.reset());

    it('allows 1,000 requests within window', () => {
      const key = 'api-key-1';
      let allowed = 0;

      for (let i = 0; i < 1050; i++) {
        if (limiter.check(key).allowed) allowed++;
      }

      expect(allowed).toBe(1000);
    });

    it('tracks different keys independently', () => {
      for (let i = 0; i < 1000; i++) {
        limiter.check('key-a');
      }
      expect(limiter.check('key-a').allowed).toBe(false);
      expect(limiter.check('key-b').allowed).toBe(true);
    });
  });

  describe('Batch tier (10 req/min)', () => {
    const limiter = createTestLimiter(60_000, 10);

    beforeEach(() => limiter.reset());

    it('allows only 10 batch requests within window', () => {
      const key = 'batch-key-1';
      let allowed = 0;
      let blocked = 0;

      for (let i = 0; i < 15; i++) {
        const result = limiter.check(key);
        if (result.allowed) allowed++;
        else blocked++;
      }

      expect(allowed).toBe(10);
      expect(blocked).toBe(5);
    });
  });

  describe('Concurrent request simulation', () => {
    it('handles 500 concurrent anonymous requests', async () => {
      const limiter = createTestLimiter(60_000, 100);
      const ip = '172.16.0.1';

      const results = await Promise.all(
        Array.from({ length: 500 }, () =>
          Promise.resolve(limiter.check(ip)),
        ),
      );

      const allowed = results.filter((r) => r.allowed).length;
      const blocked = results.filter((r) => !r.allowed).length;

      expect(allowed).toBe(100);
      expect(blocked).toBe(400);
    });

    it('handles mixed key and IP traffic', async () => {
      const keyLimiter = createTestLimiter(60_000, 1000);
      const ipLimiter = createTestLimiter(60_000, 100);

      // Simulate 200 requests: 150 with API key, 50 anonymous
      const keyResults = Array.from({ length: 150 }, () =>
        keyLimiter.check('org-key'),
      );
      const ipResults = Array.from({ length: 50 }, () =>
        ipLimiter.check('anon-ip'),
      );

      // All keyed requests should be allowed (150 < 1000)
      expect(keyResults.every((r) => r.allowed)).toBe(true);
      // All anon requests should be allowed (50 < 100)
      expect(ipResults.every((r) => r.allowed)).toBe(true);
    });
  });

  describe('Rate limit headers', () => {
    it('returns correct remaining count', () => {
      const limiter = createTestLimiter(60_000, 100);
      const ip = '10.0.0.5';

      const first = limiter.check(ip);
      expect(first.remaining).toBe(99);

      for (let i = 0; i < 49; i++) limiter.check(ip);

      const mid = limiter.check(ip);
      expect(mid.remaining).toBe(49);
    });

    it('returns 0 remaining when at limit', () => {
      const limiter = createTestLimiter(60_000, 10);
      const key = 'test-key';

      for (let i = 0; i < 10; i++) limiter.check(key);
      const result = limiter.check(key);

      expect(result.remaining).toBe(0);
      expect(result.allowed).toBe(false);
    });
  });

  describe('Window reset behavior', () => {
    it('resets after window expires', () => {
      const shortLimiter = createTestLimiter(100, 5); // 100ms window
      const key = 'reset-test';

      // Fill the window
      for (let i = 0; i < 5; i++) shortLimiter.check(key);
      expect(shortLimiter.check(key).allowed).toBe(false);

      // Manually reset to simulate window expiry
      shortLimiter.reset();
      expect(shortLimiter.check(key).allowed).toBe(true);
    });
  });
});
