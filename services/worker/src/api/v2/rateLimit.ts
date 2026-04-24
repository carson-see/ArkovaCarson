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
const entries = new Map<string, RateLimitEntry>();

export function resetV2ApiKeyRateLimit(): void {
  entries.clear();
}

export function createV2ApiKeyRateLimit(options: V2ApiKeyRateLimitOptions = {}) {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const now = options.now ?? Date.now;

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.apiKey?.keyId ?? req.ip ?? 'anonymous';
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
