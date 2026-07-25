/** SCRUM-2705: verified-payer limiter contract tests. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPayerRateLimiter,
  createPayerRateLimitMiddleware,
} from '../x402PayerRateLimit.js';

describe('createPayerRateLimiter', () => {
  let limiter: ReturnType<typeof createPayerRateLimiter>;

  afterEach(() => limiter?.destroy());

  it('allows requests through the configured limit and then blocks', () => {
    limiter = createPayerRateLimiter({ maxRequests: 2, windowMs: 60_000 });

    expect(limiter.check('opaque-hmac-a')).toMatchObject({ allowed: true, remaining: 1, limit: 2 });
    expect(limiter.check('opaque-hmac-a')).toMatchObject({ allowed: true, remaining: 0, limit: 2 });
    expect(limiter.check('opaque-hmac-a')).toMatchObject({ allowed: false, remaining: 0, limit: 2 });
  });

  it('isolates opaque HMAC payer keys', () => {
    limiter = createPayerRateLimiter({ maxRequests: 1, windowMs: 60_000 });

    limiter.check('opaque-hmac-a');
    expect(limiter.check('opaque-hmac-a').allowed).toBe(false);
    expect(limiter.check('opaque-hmac-b').allowed).toBe(true);
  });

  it('resets after the window expires', async () => {
    vi.useFakeTimers();
    limiter = createPayerRateLimiter({ maxRequests: 1, windowMs: 1_000 });
    limiter.check('opaque-hmac-a');

    await vi.advanceTimersByTimeAsync(1_001);

    expect(limiter.check('opaque-hmac-a').allowed).toBe(true);
    vi.useRealTimers();
  });

  it('fails closed instead of growing beyond the configured identity bound', () => {
    limiter = createPayerRateLimiter({ maxRequests: 10, windowMs: 60_000, maxEntries: 1 });
    limiter.check('opaque-hmac-a');

    expect(limiter.check('opaque-hmac-b')).toMatchObject({
      allowed: false,
      unavailable: true,
    });
    expect(limiter.size()).toBe(1);
  });

  it('uses the existing 1000-per-minute default', () => {
    limiter = createPayerRateLimiter();
    expect(limiter.check('opaque-hmac-a').limit).toBe(1000);
  });
});

function responseDouble() {
  const headers = new Map<string, string>();
  return {
    headers,
    setHeader: vi.fn((name: string, value: string) => headers.set(name, value)),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
}

describe('createPayerRateLimitMiddleware', () => {
  let limiter: ReturnType<typeof createPayerRateLimiter>;

  afterEach(() => limiter?.destroy());

  it('bypasses API-key and disabled-payment requests without consuming payer state', () => {
    limiter = createPayerRateLimiter({ maxRequests: 1 });
    const middleware = createPayerRateLimitMiddleware(limiter);
    const res = responseDouble();
    const next = vi.fn();

    middleware({ x402PayerContext: { kind: 'bypass', reason: 'api-key' } } as never, res as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(limiter.size()).toBe(0);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('fails closed when the payment gate did not provide trusted identity context', () => {
    limiter = createPayerRateLimiter({ maxRequests: 1 });
    const middleware = createPayerRateLimitMiddleware(limiter);
    const res = responseDouble();

    middleware({} as never, res as never, vi.fn());

    expect(res.status).toHaveBeenCalledWith(503);
    expect(limiter.size()).toBe(0);
  });

  it('emits stable payer headers and integer Retry-After on 429', () => {
    limiter = createPayerRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const middleware = createPayerRateLimitMiddleware(limiter);
    const request = { x402PayerContext: { kind: 'verified', payerKey: 'opaque-hmac-a' } };
    const firstRes = responseDouble();
    const blockedRes = responseDouble();
    const firstNext = vi.fn();
    const blockedNext = vi.fn();

    middleware(request as never, firstRes as never, firstNext);
    middleware(request as never, blockedRes as never, blockedNext);

    expect(firstNext).toHaveBeenCalledOnce();
    expect(firstRes.headers.get('X-X402-RateLimit-Limit')).toBe('1');
    expect(firstRes.headers.get('X-X402-RateLimit-Remaining')).toBe('0');
    expect(firstRes.headers.get('X-X402-RateLimit-Reset')).toMatch(/^\d+$/);
    expect(blockedRes.status).toHaveBeenCalledWith(429);
    expect(blockedRes.headers.get('Retry-After')).toMatch(/^[1-9]\d*$/);
    expect(blockedNext).not.toHaveBeenCalled();
  });

  it('maps bounded-store exhaustion to a fail-closed 503 rather than a misleading payer 429', () => {
    limiter = createPayerRateLimiter({ maxRequests: 10, maxEntries: 1 });
    const middleware = createPayerRateLimitMiddleware(limiter);
    const first = { x402PayerContext: { kind: 'verified', payerKey: 'opaque-hmac-a' } };
    const second = { x402PayerContext: { kind: 'verified', payerKey: 'opaque-hmac-b' } };
    middleware(first as never, responseDouble() as never, vi.fn());
    const res = responseDouble();

    middleware(second as never, res as never, vi.fn());

    expect(res.status).toHaveBeenCalledWith(503);
  });
});
