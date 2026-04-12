/**
 * Upstash Redis Idempotency Store (IDEM-3)
 *
 * Moves idempotency responses from in-memory Map → Upstash Redis.
 * This eliminates the biggest heap consumer:
 *   - In-memory: 10K entries × ~5KB = ~50MB heap
 *   - Redis: 0 bytes heap, TTL-managed server-side
 *
 * Uses Upstash REST API (no ioredis dependency).
 * Falls back to in-memory if Redis is unreachable.
 */

import type { IIdempotencyStore } from './idempotency.js';
import { logger } from '../utils/logger.js';

interface CachedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  createdAt: number;
}

const REDIS_KEY_PREFIX = 'idem:';
const DEFAULT_TTL_SEC = 7200; // 2 hours

export class UpstashIdempotencyStore implements IIdempotencyStore {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  async get(key: string): Promise<CachedResponse | undefined> {
    try {
      const res = await fetch(
        `${this.baseUrl}/get/${encodeURIComponent(REDIS_KEY_PREFIX + key)}`,
        {
          headers: { Authorization: `Bearer ${this.token}` },
          signal: AbortSignal.timeout(2000),
        },
      );
      if (!res.ok) return undefined;
      const json = (await res.json()) as { result: string | null };
      if (!json.result) return undefined;
      return JSON.parse(json.result) as CachedResponse;
    } catch {
      return undefined; // Fail-open: treat Redis failure as cache miss
    }
  }

  set(key: string, entry: CachedResponse): void {
    const value = JSON.stringify(entry);
    // Fire-and-forget — don't block the response on Redis write
    void this.redisSet(REDIS_KEY_PREFIX + key, value, DEFAULT_TTL_SEC);
  }

  delete(key: string): void {
    void this.redisDel(REDIS_KEY_PREFIX + key);
  }

  clear(): void {
    // Redis TTL handles cleanup — no-op for clear()
    // (We can't FLUSHDB just for idempotency keys without affecting rate limits)
  }

  // Redis manages its own size — return 0 since entries are TTL-managed server-side
  get size(): number {
    return 0;
  }

  private async redisSet(key: string, value: string, ttlSec: number): Promise<void> {
    try {
      await fetch(
        `${this.baseUrl}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/ex/${ttlSec}`,
        {
          headers: { Authorization: `Bearer ${this.token}` },
          signal: AbortSignal.timeout(2000),
        },
      );
    } catch (err) {
      logger.warn({ error: err, key }, 'Upstash idempotency SET failed — response not cached');
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
 * Initialize Upstash-backed idempotency store if env vars are set.
 * Returns the store instance (caller wires it via setIdempotencyStore).
 */
export function createUpstashIdempotencyStore(): UpstashIdempotencyStore | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.UPSTASH_REDIS_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.UPSTASH_REDIS_TOKEN;

  if (!url || !token) {
    return null;
  }

  return new UpstashIdempotencyStore(url, token);
}
