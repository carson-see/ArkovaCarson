/**
 * Rate Limiting Middleware (EFF-5)
 *
 * Pluggable rate limiter supporting both in-memory and external stores (Redis).
 * In-memory store is the default; swap to Redis for horizontal scaling.
 *
 * To share limits across Cloud Run instances: set UPSTASH_REDIS_REST_URL and
 * UPSTASH_REDIS_REST_TOKEN — `initUpstashRateLimiting()` (utils/upstashRateLimit.ts)
 * installs a store whose `increment()` is a server-side atomic counter.
 *
 * A store that implements only get/set is single-instance BY CONSTRUCTION,
 * whatever its backend: `get()` is synchronous and the limiter increments the
 * returned entry in place. Only the optional `increment()` below is a shared
 * limit. See F-1 in utils/upstashRateLimit.ts for the incident this cost.
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

  /**
   * F-1 (2026-08-12): OPTIONAL server-side atomic counter.
   *
   * The get/set pair above CANNOT express a shared limit. `get()` is
   * synchronous, so a network-backed store has nothing to return but a local
   * cache, and the middleware's read-modify-write ("read entry, mutate
   * `entry.count++` in place") never writes back at all. Any store that
   * implemented only get/set was therefore a per-instance bucket wearing a
   * distributed store's docstring — which is exactly the defect this method
   * exists to make impossible.
   *
   * A store that implements `increment` opts into the distributed path in
   * `rateLimit()`: one atomic INCR-and-return against shared state, no
   * read-modify-write, no local count. Returns the count AFTER this request is
   * counted (so the first request in a window returns 1) and the window's
   * absolute reset time as the shared store knows it.
   *
   * Stores that omit it (including the bare `Map` default) keep the original
   * synchronous single-instance path, unchanged.
   */
  increment?(key: string, windowMs: number, now: number): Promise<RateLimitEntry>;

  /**
   * Release one slot from the shared counter — the distributed counterpart of
   * the `skipFailedRequests` decrement. Best-effort: callers do not await it.
   */
  decrement?(key: string): void | Promise<void>;
}

const RATE_LIMIT_MAX_SIZE = 50_000; // cap to prevent unbounded growth (reduced from 500K — 50K covers ~800 unique IPs * ~60 paths)

/**
 * Per-request record of which limiter INSTANCES have already counted this
 * request. Lives on the request object, so it dies with the request.
 *
 * 2026-08-12 — the same limiter instance can legitimately be mounted more than
 * once (`apiIpShadowGuard` is mounted at `index.ts:418` under `/api` and again
 * unprefixed at `index.ts:446`, because `didWebRouter` serves paths outside
 * `/api` and must carry the same skip predicate). Express runs every mount a
 * request matches, so a request that falls through the first mount without
 * being answered reached the second one and got counted TWICE — making the
 * documented 60 req/min per IP actually 30. Deleting a mount was not an option;
 * counting once per instance is.
 *
 * Keyed by instance, NOT globally: index.ts deliberately shares one per-IP
 * bucket across DIFFERENT limiters (the F5 fix keys purely on scope +
 * keyGenerator), and each of those must still get its own count.
 */
const COUNTED_LIMITERS = Symbol('arkova.rateLimit.countedLimiters');

interface RequestWithCountedLimiters extends Request {
  [COUNTED_LIMITERS]?: Set<symbol>;
}

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
   * Bucket scope namespace. Defaults to '' (no scope), meaning every
   * limiter instance shares one bucket per `keyGenerator(req)` value
   * within its mount point. Set this to e.g. 'verify' or 'batch' when
   * you want a limiter to be scoped separately from other limiters
   * sharing the same key (e.g. same IP). DO NOT include `req.path` in
   * the bucket scope — that re-introduces the F5 bug below.
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
    scope = '',
    skip,
  } = options;

  /** 429 response. Identical on both paths so the contract can't drift. */
  const reject = (res: Response, key: string, entry: RateLimitEntry, now: number): void => {
    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));

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
  };

  /**
   * F-1: distributed path. Used whenever the installed store exposes an atomic
   * `increment` (i.e. it can actually hold one bucket for all N Cloud Run
   * instances). One round trip, no read-modify-write, no local counting.
   */
  const enforceShared = async (
    store: IRateLimitStore & { increment: NonNullable<IRateLimitStore['increment']> },
    key: string,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const now = Date.now();
    let entry: RateLimitEntry;

    try {
      entry = await store.increment(key, windowMs, now);
    } catch (err) {
      // Fail OPEN. A limiter that 500s when its backing store misbehaves turns
      // a Redis blip into an API outage; the store's own fallback bucket is the
      // designed degradation, and this is the last resort behind it.
      logger.error(
        { error: err, key },
        'Rate limit store threw — allowing request (fail-open)'
      );
      next();
      return;
    }

    // `increment` returns the count INCLUDING this request, so the first
    // request of a window is 1 and request maxRequests+1 is the first refusal.
    // That is the same allowance as the synchronous `count >= maxRequests`
    // check below, which tests before incrementing.
    if (entry.count > maxRequests) {
      reject(res, key, entry, now);
      return;
    }

    res.setHeader('X-RateLimit-Limit', maxRequests.toString());
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - entry.count).toString());
    res.setHeader('X-RateLimit-Reset', Math.floor(entry.resetAt / 1000).toString());

    if (skipFailedRequests) {
      const originalSend = res.send.bind(res);
      res.send = function (body: unknown) {
        if (res.statusCode >= 400) {
          // Give the slot back on the SHARED counter, not a local copy.
          void store.decrement?.(key);
        }
        return originalSend(body);
      };
    }

    next();
  };

  /**
   * Identity of THIS limiter, so a second mount of the same instance can be
   * recognised. A fresh symbol per `rateLimit()` call — two limiters built from
   * identical options are still two limiters.
   *
   * RC merge note (#2223 + #2224): the `countedBy` stamp below is checked and
   * set BEFORE the store dispatch, so a second mount is passed through without
   * charging on BOTH the synchronous path and the distributed `enforceShared`
   * path — single-count semantics hold regardless of which store is installed.
   */
  const limiterId = Symbol('rateLimiterInstance');

  return (req: Request, res: Response, next: NextFunction): void => {
    if (skip?.(req)) {
      next();
      return;
    }

    // Already counted by this same limiter earlier in the chain (a second
    // mount). The request was admitted and its X-RateLimit-* headers are
    // already set, so pass it straight through rather than charging it twice.
    const tagged = req as RequestWithCountedLimiters;
    let countedBy = tagged[COUNTED_LIMITERS];
    if (!countedBy) {
      countedBy = new Set<symbol>();
      tagged[COUNTED_LIMITERS] = countedBy;
    }
    if (countedBy.has(limiterId)) {
      next();
      return;
    }
    countedBy.add(limiterId);

    const key = scope ? `${scope}:${keyGenerator(req)}` : keyGenerator(req);
    const now = Date.now();

    // Read the store per-request: setRateLimitStore() swaps it at startup.
    const store = rateLimitStore;
    if (typeof store.increment === 'function') {
      void enforceShared(
        store as IRateLimitStore & { increment: NonNullable<IRateLimitStore['increment']> },
        key,
        res,
        next,
      );
      return;
    }

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
      reject(res, key, entry, now);
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
