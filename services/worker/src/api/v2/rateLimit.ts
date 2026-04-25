import { Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/logger.js';
import { API_V2_SCOPES, type ApiV2Scope } from '../apiScopes.js';
import { ProblemError } from './problem.js';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface V2ApiKeyRateLimitOptions {
  windowMs?: number;
  maxRequests?: number;
  now?: () => number;
  store?: V2RateLimitStore;
}

interface V2ScopeRateLimitOptions {
  windowMs?: number;
  quotas?: Partial<Record<ApiV2Scope, number>>;
  now?: () => number;
  store?: V2RateLimitStore;
}

export interface V2RateLimitStore {
  increment(key: string, windowMs: number, now: () => number): Promise<RateLimitEntry>;
  reset?(): void | Promise<void>;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<globalThis.Response>;

export const DEFAULT_V2_SCOPE_RATE_LIMITS: Record<ApiV2Scope, number> = {
  'read:search': 1_000,
  'read:records': 500,
  'read:orgs': 500,
  'write:anchors': 100,
  'admin:rules': 50,
};

const SCOPE_ENV_KEYS: Record<ApiV2Scope, string> = {
  'read:search': 'API_V2_RATE_LIMIT_READ_SEARCH_PER_MIN',
  'read:records': 'API_V2_RATE_LIMIT_READ_RECORDS_PER_MIN',
  'read:orgs': 'API_V2_RATE_LIMIT_READ_ORGS_PER_MIN',
  'write:anchors': 'API_V2_RATE_LIMIT_WRITE_ANCHORS_PER_MIN',
  'admin:rules': 'API_V2_RATE_LIMIT_ADMIN_RULES_PER_MIN',
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 1_000;

export function getV2ScopeRateLimitConfig(env: Record<string, string | undefined> = process.env): Record<ApiV2Scope, number> {
  return API_V2_SCOPES.reduce((acc, scope) => {
    acc[scope] = parsePositiveInt(env[SCOPE_ENV_KEYS[scope]], DEFAULT_V2_SCOPE_RATE_LIMITS[scope]);
    return acc;
  }, {} as Record<ApiV2Scope, number>);
}

// Per-process worker has no Redis available in dev / fallback mode. Bound the
// in-memory bucket map so a long-running worker can't OOM from accumulating
// one entry per (api_key, scope) tuple ever seen.
const SWEEP_INTERVAL_MS = 60_000;
const HARD_CAP_ENTRIES = 50_000;

export class MemoryV2RateLimitStore implements V2RateLimitStore {
  private readonly entries = new Map<string, RateLimitEntry>();
  private nextSweepAt = 0;

  async increment(key: string, windowMs: number, now: () => number): Promise<RateLimitEntry> {
    const current = now();
    this.maybeSweep(current);

    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= current) {
      entry = { count: 0, resetAt: current + windowMs };
      this.entries.set(key, entry);
    }

    entry.count += 1;
    return { ...entry };
  }

  reset(): void {
    this.entries.clear();
    this.nextSweepAt = 0;
  }

  /**
   * Drop entries whose window has expired. Runs at most once per
   * SWEEP_INTERVAL_MS so the steady-state cost is O(1) per request. If the
   * map is somehow already at the hard cap (e.g. burst of unique keys within
   * a single window), force a sweep + drop oldest-resetAt entries down to
   * 90% of the cap to avoid unbounded growth.
   */
  private maybeSweep(current: number): void {
    if (current < this.nextSweepAt && this.entries.size < HARD_CAP_ENTRIES) return;
    this.nextSweepAt = current + SWEEP_INTERVAL_MS;

    for (const [k, v] of this.entries) {
      if (v.resetAt <= current) this.entries.delete(k);
    }

    if (this.entries.size < HARD_CAP_ENTRIES) return;

    // Last-resort eviction: sort by resetAt ascending, drop the oldest.
    // Fires when size is at or above the cap — keeps semantics consistent
    // with the outer "trigger at cap" guard.
    const target = Math.floor(HARD_CAP_ENTRIES * 0.9);
    const sorted = [...this.entries.entries()].sort(
      ([, a], [, b]) => a.resetAt - b.resetAt,
    );
    for (let i = 0; i < sorted.length && this.entries.size > target; i++) {
      this.entries.delete(sorted[i][0]);
    }
  }

  /** Test-only accessor for asserting eviction behavior. */
  size(): number {
    return this.entries.size;
  }
}

export class UpstashV2RateLimitStore implements V2RateLimitStore {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly fallback = new MemoryV2RateLimitStore();

  constructor(baseUrl: string, token: string, fetchImpl: FetchLike = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async increment(key: string, windowMs: number, now: () => number): Promise<RateLimitEntry> {
    try {
      const redisKey = `arkova:v2:ratelimit:${key}`;
      const count = await this.command<number>('incr', redisKey);

      if (count === 1) {
        await this.command<number>('pexpire', redisKey, String(windowMs));
      }

      const ttlMs = await this.command<number>('pttl', redisKey);
      const resetAt = now() + (ttlMs > 0 ? ttlMs : windowMs);
      return { count, resetAt };
    } catch (err) {
      logger.warn({ error: err, key }, 'API v2 Upstash rate limit failed; using local fallback bucket');
      return this.fallback.increment(key, windowMs, now);
    }
  }

  async reset(): Promise<void> {
    this.fallback.reset();
  }

  private async command<T>(command: string, ...args: string[]): Promise<T> {
    const path = [command, ...args].map(encodeURIComponent).join('/');
    const res = await this.fetchImpl(`${this.baseUrl}/${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(2_000),
    });

    if (!res.ok) {
      throw new Error(`Upstash ${command} failed with HTTP ${res.status}`);
    }

    const json = await res.json() as { result: T };
    return json.result;
  }
}

function createDefaultStore(): V2RateLimitStore {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.UPSTASH_REDIS_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.UPSTASH_REDIS_TOKEN;

  if (url && token) {
    return new UpstashV2RateLimitStore(url, token);
  }

  return new MemoryV2RateLimitStore();
}

let defaultStore = createDefaultStore();

export function setV2RateLimitStore(store: V2RateLimitStore): void {
  defaultStore = store;
}

export function resetV2ApiKeyRateLimit(): void {
  void defaultStore.reset?.();
  if (!(defaultStore instanceof MemoryV2RateLimitStore)) {
    defaultStore = createDefaultStore();
  }
}

function setHeaders(res: Response, maxRequests: number, entry: RateLimitEntry): void {
  res.setHeader('X-RateLimit-Limit', String(maxRequests));
  res.setHeader('X-RateLimit-Reset', String(Math.floor(entry.resetAt / 1000)));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, maxRequests - entry.count)));
}

function retryAfterSeconds(entry: RateLimitEntry, now: () => number): number {
  return Math.max(1, Math.ceil((entry.resetAt - now()) / 1000));
}

function enforceBucket(
  key: string,
  maxRequests: number,
  windowMs: number,
  now: () => number,
  store: V2RateLimitStore,
  detail: string,
) {
  return async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const entry = await store.increment(key, windowMs, now);
      setHeaders(res, maxRequests, entry);

      if (entry.count > maxRequests) {
        next(ProblemError.rateLimited(retryAfterSeconds(entry, now), detail));
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

export function stopV2ApiKeyRateLimitCleanup(): void {
  // Module-level cleanup timer was removed when MemoryV2RateLimitStore took
  // ownership of bucket lifecycle. Function kept for back-compat with callers
  // (tests + jobs/shutdown.ts) that invoke it during teardown.
}

export function createV2ApiKeyRateLimit(options: V2ApiKeyRateLimitOptions = {}) {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const now = options.now ?? Date.now;
  const store = options.store ?? defaultStore;

  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip rate-limiting for unauthenticated requests so the downstream auth
    // / scope guard can return 401 instead of 429. Anonymous clients will be
    // rejected by apiKeyAuth before they ever reach the per-key bucket here.
    if (!req.apiKey) {
      next();
      return;
    }

    const key = req.apiKey.keyId;
    const bucket = enforceBucket(
      `api-key:${key}`,
      maxRequests,
      windowMs,
      now,
      store,
      `This API key exceeded the ${maxRequests.toLocaleString()} requests per minute policy.`,
    );
    void bucket(req, res, next);
  };
}

export function createV2ScopeRateLimit(scope: ApiV2Scope, options: V2ScopeRateLimitOptions = {}) {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const quotas = { ...getV2ScopeRateLimitConfig(), ...options.quotas };
  const maxRequests = quotas[scope];
  const now = options.now ?? Date.now;
  const store = options.store ?? defaultStore;

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.apiKey?.keyId ?? req.ip ?? 'anonymous';
    const bucket = enforceBucket(
      `scope:${scope}:${key}`,
      maxRequests,
      windowMs,
      now,
      store,
      `This API key exceeded the ${scope} quota of ${maxRequests.toLocaleString()} requests per minute.`,
    );
    void bucket(req, res, next);
  };
}

export const v2ApiKeyRateLimit = createV2ApiKeyRateLimit();
