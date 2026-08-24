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

// Cap to prevent unbounded growth. Keys are `${bucketScope}:${key}` — paths are
// NOT part of the key (bug-bounty F5), so the store holds one entry per
// (limiter, caller) pair per window, not one per URL. A handful of limiters see
// any given anonymous IP, so 50K comfortably covers thousands of concurrent
// callers; the 60s sweep evicts the rest.
const RATE_LIMIT_MAX_SIZE = 50_000;

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
  /**
   * Bucket scope namespace — the stable, readable name of this limiter's
   * bucket family. Omitting it no longer means "share everyone else's
   * bucket": a limiter without an explicit scope falls back to a private
   * per-instance namespace (see SCRUM-3418 below), so limiters can never
   * collide by accident. Name it anyway — every production limiter does,
   * because the name is what appears in the `Rate limit exceeded` log line
   * and what keeps the bucket stable across process restarts. DO NOT
   * include `req.path` in the bucket scope — that re-introduces the F5 bug
   * below.
   */
  scope?: string;
  /**
   * F-2 fix: optional predicate to bypass this limiter entirely for a given
   * request (e.g. traffic that a more specific, correctly-scoped limiter
   * further down the middleware chain will already enforce). Returning true
   * skips both the count and the 429 check — the request proceeds to
   * `next()` untouched, no headers set, nothing recorded in this limiter's
   * bucket. Use sparingly and document the downstream limiter it defers to.
   */
  skip?: (req: Request) => boolean;
}

/**
 * SCRUM-3418 — per-limiter default bucket scope.
 *
 * Buckets are keyed `${bucketScope}:${keyGenerator(req)}`. `scope` used to
 * default to '' and the key was the bare keyGenerator output, so EVERY limiter
 * that kept the default `req.ip` keyGenerator read and wrote ONE Map entry per
 * IP: the 60/min `apiIpShadowGuard`, the 10/min checkout limiter, the 5/min
 * auth limiter and the 100/min v1 anon limiter all shared one counter. Two
 * Constitution 1.10 violations fell out of that:
 *
 *   1. the LOWEST cap in the chain bound every surface that shared an IP with
 *      it — the checkout limiter logged `count: 60, maxRequests: 10` against
 *      callers who had never touched a checkout route; and
 *   2. one request that traversed N such limiters advanced the shared counter
 *      N times, so the effective budget was min(caps) / N rather than the
 *      documented per-tier cap.
 *
 * Each limiter instance now gets its own namespace. Every production limiter
 * passes an explicit `scope`, which is what makes the bucket name stable and
 * makes the `Rate limit exceeded` log line self-attributing. The fallback for a
 * limiter that omits one is a private per-instance id — a collision floor, not
 * a naming scheme: it is derived from construction order, so it is stable
 * within a process but not across a code change that reorders module imports.
 * Nothing in production relies on it; keep it that way, because for a
 * shared/persistent `IRateLimitStore` two processes could disagree on which
 * limiter owns `rl-3` (the in-memory default resets on restart, so it is inert
 * there).
 *
 * A single limiter instance still shares ONE bucket across all of its mount
 * points and paths — that is the F5 behaviour below and is deliberate.
 */
let limiterInstanceCount = 0;

/**
 * Create a rate limiter middleware
 *
 * 2026-04-26 — bug-bounty F5. Previous implementation keyed buckets on
 * `${req.path}:${keyGenerator(req)}`, which meant `/verify/ABC` and
 * `/verify/XYZ` got separate buckets — defeating Constitution 1.10's
 * "100 req/min per IP" intent for the public verify endpoint, where the
 * publicId is in the path. Buckets are now keyed purely on the limiter's
 * `scope` + the keyGenerator output. The default keyGenerator is
 * `req.ip`, so anon traffic correctly aggregates per-IP across paths.
 */
export function rateLimit(options: RateLimitOptions) {
  const {
    windowMs,
    maxRequests,
    keyGenerator = (req) => req.ip || 'unknown',
    skipFailedRequests = false,
    scope,
    skip,
  } = options;

  // SCRUM-3418: an unnamed limiter gets its OWN namespace, never the shared
  // bare-key bucket. Computed once per instance, not per request.
  const bucketScope = scope || `rl-${++limiterInstanceCount}`;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (skip?.(req)) {
      next();
      return;
    }

    const key = `${bucketScope}:${keyGenerator(req)}`;
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
      res.setHeader('X-RateLimit-Reset', Math.floor(entry.resetAt / 1000).toString());

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
    res.setHeader('X-RateLimit-Reset', Math.floor(currentEntry.resetAt / 1000).toString());

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
 *
 * Each carries an explicit `scope`, so the tiers below are independent budgets
 * rather than five views of one per-IP counter (SCRUM-3418). Two of them —
 * `checkout` and `quotaCheck` — are configured identically (10 req / 60s), which
 * is exactly why the scope has to name the limiter and not its config.
 */
export const rateLimiters = {
  // Stripe webhooks: 100 req/min
  stripeWebhook: rateLimit({
    windowMs: 60000,
    maxRequests: 100,
    scope: 'stripe-webhook',
    keyGenerator: () => 'stripe', // Global limit
  }),

  // Checkout: 10 req/min per IP
  checkout: rateLimit({
    windowMs: 60000,
    maxRequests: 10,
    scope: 'checkout',
  }),

  // API: 60 req/min per IP
  api: rateLimit({
    windowMs: 60000,
    maxRequests: 60,
    scope: 'api',
  }),

  // Auth: 5 req/min per IP (for failed attempts)
  auth: rateLimit({
    windowMs: 60000,
    maxRequests: 5,
    scope: 'auth',
    skipFailedRequests: true,
  }),

  // DH-08: Quota check: 10 req/min per IP
  quotaCheck: rateLimit({
    windowMs: 60000,
    maxRequests: 10,
    scope: 'quota-check',
  }),
};
