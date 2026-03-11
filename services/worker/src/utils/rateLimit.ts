/**
 * Rate Limiting Middleware
 *
 * Simple in-memory rate limiter for sensitive endpoints.
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from './logger.js';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// In-memory store (use Redis in production)
const rateLimitStore = new Map<string, RateLimitEntry>();

// Clean up expired entries — exported for testability
export function cleanupExpiredEntries(): void {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetAt < now) {
      rateLimitStore.delete(key);
    }
  }
}

// Run cleanup every minute
setInterval(cleanupExpiredEntries, 60000);

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
};
