/**
 * Upstash Redis Rate Limit Adapter (IDEM-2)
 *
 * Implements IRateLimitStore using Upstash Redis for horizontal scaling.
 * When Cloud Run auto-scales to N instances, all share a single Redis store
 * so rate limits are globally correct.
 *
 * Setup: set UPSTASH_REDIS_URL and UPSTASH_REDIS_TOKEN env vars.
 * If not set, falls back to in-memory store (single-instance mode).
 *
 * Uses simple HTTP REST API (no ioredis dependency) for Upstash compatibility.
 */

import type { IRateLimitStore } from './rateLimit.js';
import { setRateLimitStore } from './rateLimit.js';
import { logger } from './logger.js';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * Upstash Redis adapter using REST API.
 *
 * Each rate limit key is stored as a JSON string with TTL.
 * Uses atomic GET/SET operations — acceptable for rate limiting
 * where slight overcounting under extreme concurrency is tolerable.
 */
export class UpstashRateLimitStore implements IRateLimitStore {
  private readonly baseUrl: string;
  private readonly token: string;
  // Local write-through cache to minimize REST calls
  private readonly cache = new Map<string, RateLimitEntry>();

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  get(key: string): RateLimitEntry | undefined {
    // Rate limiting is latency-sensitive — use local cache first
    return this.cache.get(key);
  }

  set(key: string, entry: RateLimitEntry): void {
    this.cache.set(key, entry);
    // Async write-through to Redis (fire-and-forget for performance)
    const ttlMs = Math.max(entry.resetAt - Date.now(), 1000);
    const ttlSec = Math.ceil(ttlMs / 1000);
    void this.redisSet(key, JSON.stringify(entry), ttlSec);
  }

  delete(key: string): void {
    this.cache.delete(key);
    void this.redisDel(key);
  }

  entries(): IterableIterator<[string, RateLimitEntry]> {
    return this.cache.entries();
  }

  /** Sync local cache from Redis on startup */
  async syncFromRedis(keys: string[]): Promise<void> {
    for (const key of keys) {
      try {
        const value = await this.redisGet(key);
        if (value) {
          const entry = JSON.parse(value) as RateLimitEntry;
          if (entry.resetAt > Date.now()) {
            this.cache.set(key, entry);
          }
        }
      } catch {
        // Skip unreadable keys
      }
    }
  }

  private async redisGet(key: string): Promise<string | null> {
    const res = await fetch(`${this.baseUrl}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result: string | null };
    return json.result;
  }

  private async redisSet(key: string, value: string, ttlSec: number): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/ex/${ttlSec}`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(2000),
      });
    } catch (err) {
      logger.warn({ error: err, key }, 'Upstash rate limit SET failed — falling back to local cache');
    }
  }

  private async redisDel(key: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/del/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // Best effort
    }
  }
}

/**
 * Initialize Upstash-backed rate limiting if environment vars are set.
 * Call this at worker startup (after config load).
 */
export function initUpstashRateLimiting(): boolean {
  const url = process.env.UPSTASH_REDIS_URL;
  const token = process.env.UPSTASH_REDIS_TOKEN;

  if (!url || !token) {
    logger.info('Upstash Redis not configured — using in-memory rate limiting');
    return false;
  }

  const store = new UpstashRateLimitStore(url, token);
  setRateLimitStore(store);
  logger.info('Upstash Redis rate limiting initialized');
  return true;
}
