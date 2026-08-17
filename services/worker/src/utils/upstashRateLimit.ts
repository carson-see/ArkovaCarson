/**
 * Upstash Redis Rate Limit Adapter (IDEM-2)
 *
 * Implements IRateLimitStore using Upstash Redis so that N Cloud Run instances
 * enforce ONE bucket per key instead of N independent ones.
 *
 * Enforcement runs server-side: a single atomic `INCR` (plus `PEXPIRE` on the
 * first hit of a window) is the whole algorithm. Nothing is counted locally,
 * so there is no read-modify-write to lose and no per-instance state to
 * diverge.
 *
 * F-1 (connector-sidecar side-rig, 2026-08-12) — what this replaced and why:
 * the previous implementation kept a local `Map` and served `get()` from it
 * without ever reading Redis, while `rateLimit()` only wrote back on the
 * "create new entry" branch. Redis therefore received `{"count":0}` once per
 * window and was never consulted again; every instance enforced its own
 * private bucket. On prod (`maxScale=10`) that made every configured limit up
 * to 10x its stated value, and cold starts reset counters outright. The
 * docstring that used to sit here claimed the opposite, which is why the gap
 * survived so long — so the invariant now has a test that fails if two store
 * instances stop sharing a counter (`upstashRateLimit.distributed.test.ts`).
 *
 * Degradation is explicit, never silent: if Redis is unreachable the store
 * falls back to a bounded per-instance bucket and logs a warning on every
 * degraded request. That is the pre-fix behaviour, deliberately, as the
 * fail-open path — a rate limiter must not become an availability risk.
 *
 * Setup: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
 * (UPSTASH_REDIS_URL / UPSTASH_REDIS_TOKEN also accepted).
 * If not set, the worker keeps the in-memory store (single-instance mode).
 *
 * Uses the Upstash HTTP REST API (no ioredis dependency).
 */

import type { IRateLimitStore } from './rateLimit.js';
import { setRateLimitStore } from './rateLimit.js';
import { logger } from './logger.js';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * Counter keyspace. Deliberately distinct from the raw keys used by the legacy
 * `set()`/`get()`/`delete()` blob API below: an INCR against a key holding a
 * JSON string errors, and a `delete()` triggered by local cache expiry must
 * never be able to clear a live shared window early.
 */
const COUNTER_PREFIX = 'arkova:rl:';

const REDIS_TIMEOUT_MS = 2_000;

/** Bounds for the fail-open bucket used only while Redis is unreachable. */
const FALLBACK_MAX_ENTRIES = 50_000;
const FALLBACK_SWEEP_INTERVAL_MS = 60_000;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<globalThis.Response>;

interface PipelineReply {
  result?: unknown;
  error?: string;
}

/**
 * Upstash Redis adapter using the REST API.
 *
 * The hot path is `increment()`. `get`/`set`/`delete`/`entries`/`size` exist to
 * satisfy IRateLimitStore and to expose the fail-open bucket; they are NOT the
 * enforcement path and carry no distributed guarantee.
 */
export class UpstashRateLimitStore implements IRateLimitStore {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  /**
   * Fail-open bucket. Populated ONLY when Redis is unreachable — never from a
   * successful `increment()`, because a warm local mirror would double-count
   * against the shared counter and would let local expiry race the server TTL.
   */
  private readonly cache = new Map<string, RateLimitEntry>();
  private nextSweepAt = 0;

  constructor(baseUrl: string, token: string, fetchImpl?: FetchLike) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    // Bind lazily so tests can stub globalThis.fetch after construction.
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /**
   * F-1: the shared, atomic enforcement path.
   *
   * One round trip in the steady state (`INCR` + `PTTL` pipelined); a second
   * only on the first hit of a window, to arm the TTL. Returns the count
   * INCLUDING this request.
   */
  async increment(key: string, windowMs: number, now: number): Promise<RateLimitEntry> {
    const redisKey = COUNTER_PREFIX + key;

    try {
      const [rawCount, rawTtl] = await this.pipeline([
        ['INCR', redisKey],
        ['PTTL', redisKey],
      ]);

      const count = Number(rawCount);
      if (!Number.isFinite(count)) {
        throw new Error(`Upstash INCR returned a non-numeric value: ${String(rawCount)}`);
      }

      let ttlMs = Number(rawTtl);
      if (!Number.isFinite(ttlMs) || ttlMs < 0) {
        // ttl -1 = key exists with no expiry. That is the first hit of a
        // window, and also the shape left behind if a process died between
        // INCR and PEXPIRE — re-arming here means such a key self-heals
        // instead of blocking that bucket until someone notices.
        await this.command('pexpire', redisKey, String(windowMs));
        ttlMs = windowMs;
      }

      return { count, resetAt: now + ttlMs };
    } catch (err) {
      logger.warn(
        { error: err, key },
        'Upstash rate limit unavailable — degrading to per-instance bucket (limits are NOT shared across instances while this persists)'
      );
      return this.fallbackIncrement(key, windowMs, now);
    }
  }

  /** Release a slot on the shared counter (skipFailedRequests). Best effort. */
  async decrement(key: string): Promise<void> {
    const entry = this.cache.get(key);
    if (entry && entry.count > 0) entry.count -= 1;

    try {
      await this.command('decr', COUNTER_PREFIX + key);
    } catch (err) {
      logger.warn({ error: err, key }, 'Upstash rate limit DECR failed');
    }
  }

  /**
   * Fail-open bucket view. NOT a distributed read — it is empty unless Redis
   * has been unreachable. `rateLimit()` does not call this when `increment` is
   * available, which is every case where this class is installed.
   */
  get(key: string): RateLimitEntry | undefined {
    return this.cache.get(key);
  }

  set(key: string, entry: RateLimitEntry): void {
    this.cache.set(key, entry);
    // Async write-through to the legacy blob keyspace (fire-and-forget).
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

  get size(): number {
    return this.cache.size;
  }

  /**
   * Per-instance counting, used only while Redis is unreachable. Mirrors the
   * in-memory store's semantics and is bounded so a long outage cannot OOM the
   * worker.
   */
  private fallbackIncrement(key: string, windowMs: number, now: number): RateLimitEntry {
    this.maybeSweep(now);

    let entry = this.cache.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      this.cache.set(key, entry);
    }

    entry.count += 1;
    return { ...entry };
  }

  /** Drop expired fallback entries; hard-evict oldest if still at the cap. */
  private maybeSweep(now: number): void {
    if (now < this.nextSweepAt && this.cache.size < FALLBACK_MAX_ENTRIES) return;
    this.nextSweepAt = now + FALLBACK_SWEEP_INTERVAL_MS;

    for (const [k, v] of this.cache) {
      if (v.resetAt <= now) this.cache.delete(k);
    }

    if (this.cache.size < FALLBACK_MAX_ENTRIES) return;

    const target = Math.floor(FALLBACK_MAX_ENTRIES * 0.9);
    const sorted = [...this.cache.entries()].sort(([, a], [, b]) => a.resetAt - b.resetAt);
    for (let i = 0; i < sorted.length && this.cache.size > target; i++) {
      this.cache.delete(sorted[i][0]);
    }
  }

  /** Batch commands into one HTTP round trip. */
  private async pipeline(commands: string[][]): Promise<unknown[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`Upstash pipeline failed with HTTP ${res.status}`);
    }

    const json = (await res.json()) as PipelineReply[];
    if (!Array.isArray(json) || json.length !== commands.length) {
      throw new Error('Upstash pipeline returned an unexpected payload shape');
    }

    return json.map((reply, i) => {
      if (reply?.error) {
        throw new Error(`Upstash ${commands[i][0]} failed: ${reply.error}`);
      }
      return reply?.result;
    });
  }

  /** Single path-style REST command. */
  private async command(command: string, ...args: string[]): Promise<unknown> {
    const path = [command, ...args].map(encodeURIComponent).join('/');
    const res = await this.fetchImpl(`${this.baseUrl}/${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`Upstash ${command} failed with HTTP ${res.status}`);
    }

    const json = (await res.json()) as { result: unknown };
    return json.result;
  }

  private async redisSet(key: string, value: string, ttlSec: number): Promise<void> {
    try {
      await this.command('set', key, value, 'ex', String(ttlSec));
    } catch (err) {
      logger.warn({ error: err, key }, 'Upstash rate limit SET failed — falling back to local cache');
    }
  }

  private async redisDel(key: string): Promise<void> {
    try {
      await this.command('del', key);
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
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.UPSTASH_REDIS_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.UPSTASH_REDIS_TOKEN;

  if (!url || !token) {
    logger.info('Upstash Redis not configured — using in-memory rate limiting');
    return false;
  }

  const store = new UpstashRateLimitStore(url, token);
  setRateLimitStore(store);
  logger.info('Upstash Redis rate limiting initialized (shared counters via INCR)');
  return true;
}
