import { Request, Response, NextFunction } from 'express';
import { ProblemError } from './problem.js';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface V2ApiKeyRateLimitOptions {
  windowMs?: number;
  maxRequests?: number;
  now?: () => number;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 1_000;
const CLEANUP_INTERVAL_MS = 5 * 60_000;
const entries = new Map<string, RateLimitEntry>();

// Periodic cleanup of expired buckets so the Map can't grow unbounded under
// high cardinality (rotating keys, varying paths). Mirrors the pattern in
// services/worker/src/middleware/x402PayerRateLimit.ts.
const cleanupTimer: NodeJS.Timeout | null = (() => {
  if (typeof setInterval !== 'function') return null;
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (entry.resetAt <= now) {
        entries.delete(key);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
})();

export function resetV2ApiKeyRateLimit(): void {
  entries.clear();
}

export function stopV2ApiKeyRateLimitCleanup(): void {
  if (cleanupTimer) clearInterval(cleanupTimer);
}

export function createV2ApiKeyRateLimit(options: V2ApiKeyRateLimitOptions = {}) {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const now = options.now ?? Date.now;

  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip rate-limiting for unauthenticated requests so the downstream auth
    // / scope guard can return 401 instead of 429. Anonymous clients will be
    // rejected by apiKeyAuth before they ever reach the per-key bucket here.
    if (!req.apiKey) {
      next();
      return;
    }

    const key = req.apiKey.keyId;
    const entryKey = `${req.baseUrl}${req.path}:${key}`;
    const current = now();
    let entry = entries.get(entryKey);

    if (!entry || entry.resetAt <= current) {
      entry = { count: 0, resetAt: current + windowMs };
      entries.set(entryKey, entry);
    }

    const resetSeconds = Math.floor(entry.resetAt / 1000);
    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Reset', String(resetSeconds));

    if (entry.count >= maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - current) / 1000));
      res.setHeader('X-RateLimit-Remaining', '0');
      next(ProblemError.rateLimited(
        retryAfter,
        'This API key exceeded the 1,000 requests per minute policy.',
      ));
      return;
    }

    entry.count += 1;
    res.setHeader('X-RateLimit-Remaining', String(maxRequests - entry.count));
    next();
  };
}

export const v2ApiKeyRateLimit = createV2ApiKeyRateLimit();
