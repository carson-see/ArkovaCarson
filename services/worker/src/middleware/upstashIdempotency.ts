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
 *
 * BUG-018 / D-8 (follow-up to #2231) — every key is namespaced by environment:
 * `idem:<env>:<key>`. Production, shared staging and the connector side-rig are
 * all bound to ONE Upstash database through the same un-suffixed
 * UPSTASH_REDIS_REST_URL/_TOKEN secrets, and the key was `idem:` + the
 * caller-supplied `Idempotency-Key`, with nothing identifying the environment.
 *
 * This store exists to SUPPRESS a duplicate write, so a cross-environment
 * collision does not degrade a limit — it silently cancels real work. An
 * `Idempotency-Key` first seen on a rig returned the rig's cached response to a
 * PRODUCTION caller for the whole 2h TTL and the production write never
 * happened, with a 2xx and a response body handed back so nothing surfaced as
 * an error. The routes that carry idempotency keys are the anchor-creating
 * ones.
 *
 * The namespace comes from `resolveEnvironmentNamespace()`, derived from the
 * SERVICE identity and never from anything instance-local: deduping ACROSS
 * instances of one service is the reason IDEM-3 replaced the in-memory Map, so
 * an instance-local namespace would re-open that bug while looking like a fix.
 *
 * The env segment precedes the caller's bytes, so a crafted key such as
 * `prod:<key>` cannot reach production's segment from another surface.
 */

import type { IIdempotencyStore } from './idempotency.js';
import { logger } from '../utils/logger.js';
import { resolveEnvironmentNamespace } from '../utils/environmentNamespace.js';

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

  /**
   * BUG-018 / D-8: the environment discriminator in every key this store
   * writes. Derived once at construction from the deployment surface, so it is
   * identical for every instance of one Cloud Run service (which is what keeps
   * IDEM-3's cross-instance deduping working) and different for every other
   * service bound to the same Upstash database.
   */
  private readonly namespace: string;

  constructor(baseUrl: string, token: string, namespace?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.namespace = namespace ?? resolveEnvironmentNamespace();
  }

  /** The environment namespace this store writes under (diagnostics). */
  get environmentNamespace(): string {
    return this.namespace;
  }

  /** Namespaced key: `idem:<env>:<caller key>`. */
  private redisKey(key: string): string {
    return `${REDIS_KEY_PREFIX}${this.namespace}:${key}`;
  }

  async get(key: string): Promise<CachedResponse | undefined> {
    try {
      const res = await fetch(
        `${this.baseUrl}/get/${encodeURIComponent(this.redisKey(key))}`,
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
    void this.redisSet(this.redisKey(key), value, DEFAULT_TTL_SEC);
  }

  delete(key: string): void {
    void this.redisDel(this.redisKey(key));
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
