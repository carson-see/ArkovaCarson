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
 * BUG-018 / D-8 (FULLSOAK 2026-08 gap-closure, 2026-08-13) — every key is
 * namespaced by environment: `arkova:rl:<env>:<limiter key>`. Production,
 * shared staging and the connector side-rig are all bound to ONE Upstash
 * database through the same un-suffixed UPSTASH_REDIS_REST_URL/_TOKEN secrets,
 * and the limiter key for the per-IP guard is the bare client IP — so without
 * the `<env>` segment a burst against staging spends production's budget for
 * that IP the moment enforcement actually reads Redis (i.e. from F-1 onward).
 * The namespace comes from `resolveEnvironmentNamespace()`, which is derived
 * from the SERVICE identity and never from anything instance-local: every
 * instance of one service must land on one key, or F-1 is undone.
 *
 * Setup: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
 * (UPSTASH_REDIS_URL / UPSTASH_REDIS_TOKEN also accepted).
 * If not set, the worker keeps the in-memory store (single-instance mode).
 *
 * Uses the Upstash HTTP REST API (no ioredis dependency).
 */

import type { IRateLimitStore } from './rateLimit.js';
import { setRateLimitStore } from './rateLimit.js';
import { resolveEnvironmentNamespace } from './environmentNamespace.js';
import { logger } from './logger.js';
import { readJsonBounded } from './body-read-timeout.js';

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

/**
 * Legacy blob keyspace (`set`/`get`/`delete`). Before BUG-018 these wrote the
 * limiter key RAW — for the per-IP shadow guard that is a Redis key that is
 * literally a client IP, global across every environment bound to the database.
 * The side-rig capture read one back directly: `GET {upstash}/get/216.183.125.66`.
 */
const BLOB_PREFIX = `${COUNTER_PREFIX}blob:`;

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
 * Minimal per-instance circuit breaker guarding the `increment()` pipeline
 * call — the blocking hot path (`rateLimit()` awaits it before `next()`).
 * Without this, a full Upstash outage costs every rate-limited request the
 * full `REDIS_TIMEOUT_MS` (2s) forever, because nothing ever stops the store
 * from retrying Redis on every single call before falling back.
 *
 * LATENCY SHIELD, NOT A CORRECTNESS MECHANISM: state lives only in this
 * process, so each Cloud Run instance trips and recovers independently and
 * none of them coordinate. That is fine — the shared counter's fail-open
 * bucket (`fallbackIncrement`) is what keeps enforcement bounded during an
 * outage; this only decides how fast one instance stops paying to find out
 * Redis is still down.
 */
class UpstashCircuitBreaker {
  private static readonly FAILURE_THRESHOLD = 5;
  private static readonly RECOVERY_MS = 30_000;

  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;

  /** Should this call attempt Redis, or skip straight to the fail-open bucket? */
  shouldAttempt(now: number): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'half-open') return false; // a probe is already in flight

    if (now - this.openedAt < UpstashCircuitBreaker.RECOVERY_MS) return false;
    this.state = 'half-open'; // this call becomes the one probe
    return true;
  }

  onSuccess(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
  }

  onFailure(now: number): void {
    if (this.state === 'half-open') {
      // A failed probe re-opens outright — no need to re-accumulate failures.
      this.state = 'open';
      this.openedAt = now;
      return;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= UpstashCircuitBreaker.FAILURE_THRESHOLD) {
      this.state = 'open';
      this.openedAt = now;
    }
  }
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
   * BUG-018 / D-8: the environment discriminator in every key this store
   * writes. Derived once at construction from the deployment surface, so it is
   * identical for every instance of one Cloud Run service (which is what keeps
   * PR #2223's cross-instance sharing working) and different for every other
   * service bound to the same Upstash database.
   */
  private readonly namespace: string;

  /**
   * Fail-open bucket. Populated ONLY when Redis is unreachable — never from a
   * successful `increment()`, because a warm local mirror would double-count
   * against the shared counter and would let local expiry race the server TTL.
   */
  private readonly cache = new Map<string, RateLimitEntry>();
  private nextSweepAt = 0;

  /** See `UpstashCircuitBreaker` — shields `increment()` from paying REDIS_TIMEOUT_MS on every call during an outage. */
  private readonly breaker = new UpstashCircuitBreaker();

  constructor(baseUrl: string, token: string, fetchImpl?: FetchLike, namespace?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    // Bind lazily so tests can stub globalThis.fetch after construction.
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
    this.namespace = namespace ?? resolveEnvironmentNamespace();
  }

  /** The environment namespace this store writes under (diagnostics). */
  get environmentNamespace(): string {
    return this.namespace;
  }

  /** Shared-counter key: `arkova:rl:<env>:<limiter key>`. */
  private counterKey(key: string): string {
    return `${COUNTER_PREFIX}${this.namespace}:${key}`;
  }

  /** Legacy blob key: `arkova:rl:blob:<env>:<limiter key>`. */
  private blobKey(key: string): string {
    return `${BLOB_PREFIX}${this.namespace}:${key}`;
  }

  /**
   * F-1: the shared, atomic enforcement path.
   *
   * One round trip in the steady state (`INCR` + `PTTL` pipelined); a second
   * only on the first hit of a window, to arm the TTL. Returns the count
   * INCLUDING this request.
   */
  async increment(key: string, windowMs: number, now: number): Promise<RateLimitEntry> {
    const redisKey = this.counterKey(key);

    if (!this.breaker.shouldAttempt(now)) {
      // Breaker OPEN: skip the round trip entirely rather than pay up to
      // REDIS_TIMEOUT_MS to rediscover Redis is still down.
      return this.fallbackIncrement(key, windowMs, now);
    }

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

      this.breaker.onSuccess();
      return { count, resetAt: now + ttlMs };
    } catch (err) {
      this.breaker.onFailure(now);
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
      await this.command('decr', this.counterKey(key));
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

    // F-D0-5: bound the BODY read too — AbortSignal.timeout above only bounds
    // the request. A stalled body on this hot path would park `increment()`
    // forever without ever reaching the fail-open local bucket. The label is
    // the static `/pipeline` URL: no key, so nothing caller-derived is logged.
    const json = (await readJsonBounded(
      res,
      `${this.baseUrl}/pipeline`,
      REDIS_TIMEOUT_MS,
    )) as PipelineReply[];
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

    // F-D0-5, as in pipeline(). The label deliberately omits `path`: it is
    // `<command>/<key>` and an anonymous limiter key IS a caller IP, which
    // BodyReadTimeoutError would embed verbatim in a logged message (§1.4).
    const json = (await readJsonBounded(
      res,
      `${this.baseUrl}/${command}`,
      REDIS_TIMEOUT_MS,
    )) as { result: unknown };
    return json.result;
  }

  private async redisSet(key: string, value: string, ttlSec: number): Promise<void> {
    try {
      await this.command('set', this.blobKey(key), value, 'ex', String(ttlSec));
    } catch (err) {
      logger.warn({ error: err, key }, 'Upstash rate limit SET failed — falling back to local cache');
    }
  }

  private async redisDel(key: string): Promise<void> {
    try {
      await this.command('del', this.blobKey(key));
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
  logger.info(
    { environmentNamespace: store.environmentNamespace },
    'Upstash Redis rate limiting initialized (shared counters via INCR)'
  );
  return true;
}
