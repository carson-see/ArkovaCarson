/**
 * Bounded process-local rate limiter for verified x402 payer identities.
 *
 * The payment gate supplies an opaque HMAC key derived from the verified
 * on-chain sender. Raw wallet addresses must never enter this store.
 */
import type { NextFunction, Request, Response } from 'express';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface PayerRateLimitConfig {
  /** Maximum requests per payer/window. */
  maxRequests: number;
  /** Window duration in milliseconds. */
  windowMs: number;
  /** Hard bound on concurrently tracked payer identities. */
  maxEntries: number;
}

export interface PayerRateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  resetAt: number;
  limit: number;
  /** True when safe tracking was impossible; callers must return 503. */
  unavailable?: boolean;
}

const DEFAULT_CONFIG: PayerRateLimitConfig = {
  maxRequests: 1000,
  windowMs: 60_000,
  maxEntries: 10_000,
};

export function createPayerRateLimiter(config: Partial<PayerRateLimitConfig> = {}) {
  const { maxRequests, windowMs, maxEntries } = { ...DEFAULT_CONFIG, ...config };
  if (
    !Number.isSafeInteger(maxRequests)
    || maxRequests < 1
    || !Number.isSafeInteger(windowMs)
    || windowMs < 1
    || !Number.isSafeInteger(maxEntries)
    || maxEntries < 1
  ) {
    throw new Error('Invalid x402 payer limiter configuration');
  }

  const store = new Map<string, RateLimitEntry>();

  function removeExpired(now: number): void {
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) store.delete(key);
    }
  }

  const cleanupInterval = setInterval(() => removeExpired(Date.now()), 5 * 60_000);
  cleanupInterval.unref?.();

  return {
    check(payerKey: string): PayerRateLimitResult {
      const now = Date.now();
      let entry = store.get(payerKey);
      if (entry?.resetAt != null && entry.resetAt <= now) {
        store.delete(payerKey);
        entry = undefined;
      }

      if (!entry) {
        removeExpired(now);
        if (!payerKey || store.size >= maxEntries) {
          return {
            allowed: false,
            remaining: 0,
            retryAfterMs: windowMs,
            resetAt: now + windowMs,
            limit: maxRequests,
            unavailable: true,
          };
        }
        entry = { count: 0, resetAt: now + windowMs };
        store.set(payerKey, entry);
      }

      entry.count += 1;
      const allowed = entry.count <= maxRequests;
      return {
        allowed,
        remaining: allowed ? maxRequests - entry.count : 0,
        retryAfterMs: allowed ? 0 : Math.max(1, entry.resetAt - now),
        resetAt: entry.resetAt,
        limit: maxRequests,
      };
    },

    reset(): void {
      store.clear();
    },

    size(): number {
      return store.size;
    },

    destroy(): void {
      clearInterval(cleanupInterval);
    },
  };
}

export type PayerRateLimiter = ReturnType<typeof createPayerRateLimiter>;

export function createPayerRateLimitMiddleware(limiter: PayerRateLimiter) {
  return function x402VerifiedPayerRateLimit(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const context = req.x402PayerContext;
    if (context?.kind === 'bypass') {
      next();
      return;
    }
    if (context?.kind !== 'verified' || !context.payerKey) {
      res.status(503).json({
        error: 'payer_identity_unavailable',
        message: 'Verified payer identity is unavailable.',
      });
      return;
    }

    const result = limiter.check(context.payerKey);
    if (result.unavailable) {
      res.status(503).json({
        error: 'payer_rate_limit_unavailable',
        message: 'Payer rate limiting is temporarily unavailable.',
      });
      return;
    }

    res.setHeader('X-X402-RateLimit-Limit', String(result.limit));
    res.setHeader('X-X402-RateLimit-Remaining', String(result.remaining));
    res.setHeader('X-X402-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));

    if (!result.allowed) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
      res.status(429).json({
        error: 'x402_payer_rate_limit_exceeded',
        message: 'Verified payer request limit exceeded.',
      });
      return;
    }

    next();
  };
}

const payerRateLimiter = createPayerRateLimiter();
export const x402PayerRateLimit = createPayerRateLimitMiddleware(payerRateLimiter);
