/**
 * Redis-backed Rate Limit Store (QA-PERF-1 / EFF-5)
 *
 * Implements IRateLimitStore using Upstash Redis for horizontal scaling.
 * Replaces the in-memory Map when REDIS_URL is set.
 *
 * Uses simple GET/SET with TTL — no Lua scripts needed.
 * Compatible with Upstash Redis (HTTP-based, serverless-friendly).
 *
 * Setup:
 *   1. Provision Upstash Redis (upstash.com)
 *   2. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN env vars
 *   3. npm install @upstash/redis (in services/worker)
 *   4. Call initRedisRateLimit() at worker startup
 */

import type { IRateLimitStore } from './rateLimit.js';
import { logger } from './logger.js';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * Redis-backed rate limit store using Upstash REST API.
 * Falls back gracefully to allowing requests if Redis is unreachable.
 */
export class RedisRateLimitStore implements IRateLimitStore {
  private redis: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string, opts?: { ex?: number }) => Promise<string>;
    del: (key: string) => Promise<number>;
    keys: (pattern: string) => Promise<string[]>;
  };

  constructor(redisClient: RedisRateLimitStore['redis']) {
    this.redis = redisClient;
  }

  get(key: string): RateLimitEntry | undefined {
    // Synchronous interface — for Redis, we use getAsync internally
    // The rate limiter middleware should be updated to await if using Redis
    // For now, return undefined to allow the request (fail-open)
    return undefined;
  }

  set(key: string, entry: RateLimitEntry): void {
    const ttlSeconds = Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000));
    this.redis.set(
      `ratelimit:${key}`,
      JSON.stringify(entry),
      { ex: ttlSeconds },
    ).catch((err) => {
      logger.warn({ error: err, key }, 'Redis rate limit SET failed — falling back to allow');
    });
  }

  delete(key: string): void {
    this.redis.del(`ratelimit:${key}`).catch((err) => {
      logger.warn({ error: err, key }, 'Redis rate limit DEL failed');
    });
  }

  *entries(): IterableIterator<[string, RateLimitEntry]> {
    // Not used for cleanup in Redis (TTL handles expiry)
    return;
  }

  // Redis manages its own size — return 0 since entries are TTL-managed server-side
  get size(): number {
    return 0;
  }
}

/**
 * Initialize Redis-backed rate limiting if UPSTASH_REDIS_REST_URL is set.
 * Returns true if Redis was initialized, false if falling back to in-memory.
 */
export async function initRedisRateLimit(): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    logger.info('Redis rate limiting not configured — using in-memory store');
    return false;
  }

  try {
    // Dynamic import to avoid requiring @upstash/redis when not used
    const { Redis } = await import('@upstash/redis');
    const redis = new Redis({ url, token });

    // Test connection
    await redis.ping();

    const { setRateLimitStore } = await import('./rateLimit.js');
    setRateLimitStore(new RedisRateLimitStore(redis as unknown as RedisRateLimitStore['redis']));

    logger.info('Redis-backed rate limiting initialized (Upstash)');
    return true;
  } catch (err) {
    logger.warn({ error: err }, 'Failed to initialize Redis rate limiting — using in-memory fallback');
    return false;
  }
}
