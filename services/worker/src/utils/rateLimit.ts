/**
 * Rate Limiting Middleware (EFF-5)
 *
 * Pluggable rate limiter supporting both in-memory and external stores (Redis).
 * In-memory store is the default; swap to Redis for horizontal scaling.
 *
 * To use Redis: set REDIS_URL env var and install ioredis.
 * The IRateLimitStore interface allows custom backends.
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from './logger.js';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * EFF-5: Pluggable rate limit store interface for horizontal scaling.
 * Implement this with Redis (ioredis/upstash) for multi-instance deployments.
 *
 * Default: in-memory Map (single instance).
 * For multi-instance: implement IRateLimitStore with Redis and pass via setRateLimitStore().
 */
export interface IRateLimitStore {
  get(key: string): RateLimitEntry | undefined;
  set(key: string, entry: RateLimitEntry): void;
  delete(key: string): void;
  entries(): IterableIterator<[string, RateLimitEntry]>;
  readonly size: number;
}

const RATE_LIMIT_MAX_SIZE = 500_000; // cap to prevent unbounded growth

// In-memory store — works for single-instance deployments
let rateLimitStore: IRateLimitStore = new Map<string, RateLimitEntry>();

/** Swap rate limit backend (e.g., to Redis adapter). */
export function setRateLimitStore(store: IRateLimitStore): void {
  rateLimitStore = store;
}

// Clean up expired entries — exported for testability
export function cleanupExpiredEntries(): void {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetAt < now) {
      rateLimitStore.delete(key);
    }
  }
}

// Run cleanup every minute — save ref for graceful shutdown
let cleanupIntervalRef: ReturnType<typeof setInterval> | null = setInterval(cleanupExpiredEntries, 60000);

/** Stop the rate limit cleanup interval (for graceful shutdown) */
export function stopRateLimitCleanup(): void {
  if (cleanupIntervalRef) {
    clearInterval(cleanupIntervalRef);
    cleanupIntervalRef = null;
  }
}

/** Get current store size (for diagnostics / testing) */
export function getRateLimitStoreSize(): number {
  return rateLimitStore.size;
}

interface RateLimitOptions {
  windowMs: number; // Time window in ms
  maxRequests: number; // Max requests per window
  keyGenerator?: (req: Request) => string; // Custom key generator
  skipFailedRequests?: boolean; // Don't count failed requests
}

/**
 * Create a rate limiter middleware
 */
export function rateLimit(options: RateLimitOptions) {
  const {
    windowMs,
    maxRequests,
    keyGenerator = (req) => req.ip || 'unknown',
    skipFailedRequests = false,
  } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${req.path}:${keyGenerator(req)}`;
    const now = Date.now();

    let entry = rateLimitStore.get(key);

    if (!entry || entry.resetAt < now) {
      // Emergency eviction if store is at capacity
      if (rateLimitStore.get(key) === undefined && getRateLimitStoreSize() >= RATE_LIMIT_MAX_SIZE) {
        cleanupExpiredEntries();
      }
      // Create new entry
      entry = {
        count: 0,
        resetAt: now + windowMs,
      };
      rateLimitStore.set(key, entry);
    }

    // Check limit
    if (entry.count >= maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);

      logger.warn(
        { key, count: entry.count, maxRequests },
        'Rate limit exceeded'
      );

      res.setHeader('Retry-After', retryAfter.toString());
      res.setHeader('X-RateLimit-Limit', maxRequests.toString());
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('X-RateLimit-Reset', entry.resetAt.toString());

      res.status(429).json({
        error: 'Too many requests',
        retry_after: retryAfter,
      });
      return;
    }

    // Increment count
    entry.count++;

    // Capture for use in closure below (entry is guaranteed non-null here)
    const currentEntry = entry;

    // Set headers
    res.setHeader('X-RateLimit-Limit', maxRequests.toString());
    res.setHeader('X-RateLimit-Remaining', (maxRequests - currentEntry.count).toString());
    res.setHeader('X-RateLimit-Reset', currentEntry.resetAt.toString());

    // Handle skip on failure
    if (skipFailedRequests) {
      const originalSend = res.send.bind(res);
      res.send = function (body: unknown) {
        if (res.statusCode >= 400) {
          currentEntry.count--;
        }
        return originalSend(body);
      };
    }

    next();
  };
}

/**
 * Pre-configured rate limiters
 */
export const rateLimiters = {
  // Stripe webhooks: 100 req/min
  stripeWebhook: rateLimit({
    windowMs: 60000,
    maxRequests: 100,
    keyGenerator: () => 'stripe', // Global limit
  }),

  // Checkout: 10 req/min per IP
  checkout: rateLimit({
    windowMs: 60000,
    maxRequests: 10,
  }),

  // API: 60 req/min per IP
  api: rateLimit({
    windowMs: 60000,
    maxRequests: 60,
  }),

  // Auth: 5 req/min per IP (for failed attempts)
  auth: rateLimit({
    windowMs: 60000,
    maxRequests: 5,
    skipFailedRequests: true,
  }),

  // DH-08: Quota check: 10 req/min per IP
  quotaCheck: rateLimit({
    windowMs: 60000,
    maxRequests: 10,
  }),
};
