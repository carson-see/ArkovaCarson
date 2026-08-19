/**
 * Distributed rate-limit regression suite (F-1, connector-sidecar side-rig 2026-08-12)
 *
 * The bug this file exists to prevent from ever coming back:
 *
 *   `UpstashRateLimitStore.get()` returned `this.cache.get(key)` and never read
 *   Redis, and `rateLimit()` only ever called `store.set()` on the *create new
 *   entry* branch — the later `entry.count++` mutated the object in place with
 *   no write-back. So Redis received `{"count":0}` once per window and was
 *   never consulted again. Every Cloud Run instance enforced its own private
 *   in-memory bucket while the HTTP headers claimed a shared one, so the real
 *   ceiling was `configured_limit x instance_count` (prod: maxScale=10).
 *
 * Empirically confirmed on the side-rig: `x-ratelimit-remaining` walked
 * 48 -> 46 -> 44 while the Upstash value for that same key stayed frozen at
 * `{"count":0,"resetAt":...}` across all three requests.
 *
 * The load-bearing assertion in here is `two independent store instances
 * sharing one Redis key enforce ONE combined limit`. Every other test supports
 * it. The old suite (`upstashRateLimit.test.ts`) only ever exercised a single
 * store against its own local cache, which is exactly why it stayed green
 * through the entire lifetime of the defect.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { UpstashRateLimitStore } from './upstashRateLimit.js';
import {
  rateLimit,
  setRateLimitStore,
  stopRateLimitCleanup,
  type IRateLimitStore,
} from './rateLimit.js';
import { resolveEnvironmentNamespace } from './environmentNamespace.js';
import { logger } from './logger.js';

const BASE_URL = 'https://fake-redis.upstash.io';
const TOKEN = 'fake-token';

/**
 * Minimal in-process stand-in for the Upstash REST API.
 *
 * Models the only property that matters for this suite: server-side state that
 * is shared by every client pointed at it, with genuinely atomic INCR/DECR.
 * Supports both transports the adapter can use — the `/pipeline` POST (array
 * of command arrays) and the path-style `GET /cmd/arg/arg`.
 */
class FakeUpstash {
  /** key -> integer counter value */
  private readonly counters = new Map<string, number>();
  /** key -> absolute expiry (ms epoch); absent means "no TTL set" */
  private readonly expiries = new Map<string, number>();
  /** key -> opaque string (legacy GET/SET keyspace) */
  private readonly strings = new Map<string, string>();

  /** Every command the fake server received, in order — for transport assertions. */
  readonly commandLog: string[][] = [];

  /** Set true to make every request fail, simulating a Redis outage. */
  unreachable = false;

  constructor(private now: () => number = Date.now) {}

  /** Raw counter value as Redis holds it — the thing the side-rig saw frozen. */
  peekCounter(key: string): number | undefined {
    this.expireIfDue(key);
    return this.counters.get(key);
  }

  peekTtlMs(key: string): number {
    this.expireIfDue(key);
    if (!this.counters.has(key)) return -2;
    const expiry = this.expiries.get(key);
    if (expiry === undefined) return -1;
    return expiry - this.now();
  }

  peekString(key: string): string | undefined {
    return this.strings.get(key);
  }

  /** Advance past a key's TTL the way a real server would. */
  private expireIfDue(key: string): void {
    const expiry = this.expiries.get(key);
    if (expiry !== undefined && expiry <= this.now()) {
      this.counters.delete(key);
      this.strings.delete(key);
      this.expiries.delete(key);
    }
  }

  private exec(argv: string[]): unknown {
    this.commandLog.push(argv);
    const [rawCmd, key, ...rest] = argv;
    const cmd = rawCmd.toLowerCase();
    this.expireIfDue(key);

    switch (cmd) {
      case 'incr': {
        const next = (this.counters.get(key) ?? 0) + 1;
        this.counters.set(key, next);
        return next;
      }
      case 'decr': {
        const next = (this.counters.get(key) ?? 0) - 1;
        this.counters.set(key, next);
        return next;
      }
      case 'pttl':
        return this.peekTtlMs(key);
      case 'pexpire': {
        if (!this.counters.has(key) && !this.strings.has(key)) return 0;
        this.expiries.set(key, this.now() + Number(rest[0]));
        return 1;
      }
      case 'get':
        return this.strings.get(key) ?? null;
      case 'set': {
        this.strings.set(key, rest[0]);
        const exIdx = rest.findIndex((a) => a.toLowerCase() === 'ex');
        if (exIdx >= 0) this.expiries.set(key, this.now() + Number(rest[exIdx + 1]) * 1000);
        return 'OK';
      }
      case 'del': {
        const existed = this.counters.delete(key) || this.strings.delete(key);
        this.expiries.delete(key);
        return existed ? 1 : 0;
      }
      default:
        throw new Error(`FakeUpstash: unsupported command ${cmd}`);
    }
  }

  /** Drop-in for globalThis.fetch. */
  readonly fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    if (this.unreachable) throw new Error('ECONNREFUSED (simulated Redis outage)');

    const url = typeof input === 'string' ? input : input.toString();
    if (!url.startsWith(BASE_URL)) throw new Error(`FakeUpstash: unexpected host ${url}`);
    if (init?.headers && (init.headers as Record<string, string>).Authorization !== `Bearer ${TOKEN}`) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    }

    const path = url.slice(BASE_URL.length).replace(/^\//, '');

    if (path === 'pipeline' || path === 'multi-exec') {
      const commands = JSON.parse(String(init?.body ?? '[]')) as string[][];
      const results = commands.map((argv) => ({ result: this.exec(argv.map(String)) }));
      return new Response(JSON.stringify(results), { status: 200 });
    }

    const argv = path.split('/').map(decodeURIComponent);
    return new Response(JSON.stringify({ result: this.exec(argv) }), { status: 200 });
  };
}

/**
 * Counter key the adapter is expected to use for a given limiter key.
 *
 * BUG-018 added the `<env>` segment (`arkova:rl:<env>:<key>`). It is derived
 * here rather than hardcoded so this helper cannot drift from the store, and
 * so the sharing assertions below keep testing SHARING rather than accidentally
 * testing the namespace: every store built in this file resolves the same
 * environment, so they must all land on this one key.
 */
const counterKey = (key: string) => `arkova:rl:${resolveEnvironmentNamespace()}:${key}`;

let redis: FakeUpstash;

beforeEach(() => {
  redis = new FakeUpstash();
  vi.stubGlobal('fetch', redis.fetch);
  vi.mocked(logger.warn).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Leave the module-level store in a known state for the next test.
  setRateLimitStore(new Map());
});

afterAll(() => {
  stopRateLimitCleanup();
});

describe('UpstashRateLimitStore — distributed counter (F-1)', () => {
  it('two independent store instances sharing one Redis key enforce ONE combined limit', async () => {
    // Two Cloud Run instances, same config, same Redis, same client IP.
    const instanceA = new UpstashRateLimitStore(BASE_URL, TOKEN);
    const instanceB = new UpstashRateLimitStore(BASE_URL, TOKEN);
    const key = 'ip:203.0.113.7';
    const windowMs = 60_000;

    const counts: number[] = [];
    for (const instance of [instanceA, instanceA, instanceA, instanceB, instanceB, instanceB]) {
      const entry = await instance.increment(key, windowMs, Date.now());
      counts.push(entry.count);
    }

    // The whole finding in one assertion: the second instance must continue the
    // first instance's count, not start its own bucket at 1.
    expect(counts).toEqual([1, 2, 3, 4, 5, 6]);
    expect(redis.peekCounter(counterKey(key))).toBe(6);
  });

  it('a cold-started instance sees the count an established instance already accrued', async () => {
    const warm = new UpstashRateLimitStore(BASE_URL, TOKEN);
    const key = 'ip:198.51.100.4';
    for (let i = 0; i < 40; i++) await warm.increment(key, 60_000, Date.now());

    // Cold start: brand-new process, empty local cache.
    const cold = new UpstashRateLimitStore(BASE_URL, TOKEN);
    const entry = await cold.increment(key, 60_000, Date.now());

    expect(entry.count).toBe(41);
  });

  it('moves the value in Redis on every request, not just the first', async () => {
    // The side-rig signature: headers decremented while Redis stayed at count:0.
    const store = new UpstashRateLimitStore(BASE_URL, TOKEN);
    const key = 'ip:192.0.2.99';

    const observed: Array<number | undefined> = [];
    for (let i = 0; i < 3; i++) {
      await store.increment(key, 60_000, Date.now());
      observed.push(redis.peekCounter(counterKey(key)));
    }

    expect(observed).toEqual([1, 2, 3]);
  });

  it('arms a TTL on the first hit of a window and does not extend it on later hits', async () => {
    const store = new UpstashRateLimitStore(BASE_URL, TOKEN);
    const key = 'ip:203.0.113.50';
    const windowMs = 60_000;

    await store.increment(key, windowMs, Date.now());
    const ttlAfterFirst = redis.peekTtlMs(counterKey(key));
    expect(ttlAfterFirst).toBeGreaterThan(0);
    expect(ttlAfterFirst).toBeLessThanOrEqual(windowMs);

    // A sliding TTL would let sustained traffic hold a key blocked forever.
    const pexpiresBefore = redis.commandLog.filter((c) => c[0].toLowerCase() === 'pexpire').length;
    await store.increment(key, windowMs, Date.now());
    await store.increment(key, windowMs, Date.now());
    const pexpiresAfter = redis.commandLog.filter((c) => c[0].toLowerCase() === 'pexpire').length;

    expect(pexpiresAfter).toBe(pexpiresBefore);
  });

  it('derives resetAt from the server-side TTL, so every instance reports the same reset', async () => {
    const instanceA = new UpstashRateLimitStore(BASE_URL, TOKEN);
    const instanceB = new UpstashRateLimitStore(BASE_URL, TOKEN);
    const key = 'ip:203.0.113.60';
    const now = Date.now();

    const a = await instanceA.increment(key, 60_000, now);
    const b = await instanceB.increment(key, 60_000, now);

    // Same window, same reset — within a small tolerance for the fake clock.
    expect(Math.abs(a.resetAt - b.resetAt)).toBeLessThanOrEqual(50);
    expect(a.resetAt).toBeGreaterThan(now);
  });

  it('re-arms the TTL if a key somehow lost its expiry (no permanent lockout)', async () => {
    const store = new UpstashRateLimitStore(BASE_URL, TOKEN);
    const key = 'ip:203.0.113.61';
    const redisKey = counterKey(key);

    // Simulate a crash between INCR and PEXPIRE: counter exists, no TTL.
    await redis.fetch(`${BASE_URL}/incr/${encodeURIComponent(redisKey)}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(redis.peekTtlMs(redisKey)).toBe(-1);

    await store.increment(key, 60_000, Date.now());

    expect(redis.peekTtlMs(redisKey)).toBeGreaterThan(0);
  });

  it('uses a single round trip per request in the steady state', async () => {
    const store = new UpstashRateLimitStore(BASE_URL, TOKEN);
    const key = 'ip:203.0.113.70';

    await store.increment(key, 60_000, Date.now()); // first hit arms the window
    const fetchSpy = vi.fn(redis.fetch);
    vi.stubGlobal('fetch', fetchSpy);

    await store.increment(key, 60_000, Date.now());

    // rateLimiters.api sits in front of nearly every route — a second
    // sequential REST hop per request is real added latency on the hot path.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('decrement releases a slot in Redis, not just locally', async () => {
    const instanceA = new UpstashRateLimitStore(BASE_URL, TOKEN);
    const instanceB = new UpstashRateLimitStore(BASE_URL, TOKEN);
    const key = 'ip:203.0.113.80';

    await instanceA.increment(key, 60_000, Date.now());
    await instanceA.increment(key, 60_000, Date.now());
    await instanceA.decrement(key);
    expect(redis.peekCounter(counterKey(key))).toBe(1);

    const entry = await instanceB.increment(key, 60_000, Date.now());
    expect(entry.count).toBe(2);
  });
});

describe('UpstashRateLimitStore — fail-open behaviour when Redis is unreachable', () => {
  it('falls back to a per-instance bucket and logs the degradation', async () => {
    const store = new UpstashRateLimitStore(BASE_URL, TOKEN);
    redis.unreachable = true;

    const first = await store.increment('ip:203.0.113.90', 60_000, Date.now());
    const second = await store.increment('ip:203.0.113.90', 60_000, Date.now());

    // Still counting — a dead Redis must not mean "unlimited".
    expect(first.count).toBe(1);
    expect(second.count).toBe(2);

    // Explicit and logged, per the fix's design contract — not silent.
    expect(logger.warn).toHaveBeenCalled();
    const [payload] = vi.mocked(logger.warn).mock.calls[0];
    expect(JSON.stringify(payload)).toMatch(/ip:203\.0\.113\.90/);
  });

  it('recovers to the shared counter once Redis comes back', async () => {
    const store = new UpstashRateLimitStore(BASE_URL, TOKEN);
    const key = 'ip:203.0.113.91';

    redis.unreachable = true;
    await store.increment(key, 60_000, Date.now());

    redis.unreachable = false;
    const recovered = await store.increment(key, 60_000, Date.now());

    // Back on the shared counter (which this instance had not yet reached).
    expect(recovered.count).toBe(1);
    expect(redis.peekCounter(counterKey(key))).toBe(1);
  });

  it('does not let the fail-open bucket grow without bound', async () => {
    const store = new UpstashRateLimitStore(BASE_URL, TOKEN);
    redis.unreachable = true;

    const windowMs = 1;
    const start = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(start);
    for (let i = 0; i < 200; i++) await store.increment(`ip:burst-${i}`, windowMs, Date.now());
    // Past every one of those windows AND past the fallback sweep interval.
    vi.setSystemTime(start + 61_000);
    await store.increment('ip:sweeper', windowMs, Date.now());
    vi.useRealTimers();

    // Expired fallback entries must not accumulate for the life of the process.
    expect(store.size).toBeLessThan(200);
  });
});

describe('rateLimit() middleware over a distributed store', () => {
  /** App with one limiter, reading whatever store is currently installed. */
  function appWithLimiter(maxRequests: number) {
    const app = express();
    app.set('trust proxy', true);
    app.use(rateLimit({ windowMs: 60_000, maxRequests, keyGenerator: () => 'fixed-key' }));
    app.get('/probe', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    return app;
  }

  it('enforces one bucket across instances — the request served by instance B is blocked by instance A traffic', async () => {
    const instanceA = new UpstashRateLimitStore(BASE_URL, TOKEN);
    const instanceB = new UpstashRateLimitStore(BASE_URL, TOKEN);
    const app = appWithLimiter(3);

    // Two requests land on instance A.
    setRateLimitStore(instanceA);
    await request(app).get('/probe').expect(200);
    await request(app).get('/probe').expect(200);

    // The load balancer moves the client to instance B, whose local cache is empty.
    setRateLimitStore(instanceB);
    await request(app).get('/probe').expect(200); // 3rd overall — still allowed
    const blocked = await request(app).get('/probe').expect(429); // 4th overall

    expect(blocked.body).toMatchObject({ error: 'Too many requests' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('reports X-RateLimit-Remaining from the shared counter, not the local cache', async () => {
    const instanceA = new UpstashRateLimitStore(BASE_URL, TOKEN);
    const instanceB = new UpstashRateLimitStore(BASE_URL, TOKEN);
    const app = appWithLimiter(10);

    setRateLimitStore(instanceA);
    const a1 = await request(app).get('/probe').expect(200);
    const a2 = await request(app).get('/probe').expect(200);

    setRateLimitStore(instanceB);
    const b1 = await request(app).get('/probe').expect(200);

    expect(a1.headers['x-ratelimit-remaining']).toBe('9');
    expect(a2.headers['x-ratelimit-remaining']).toBe('8');
    // The defect's fingerprint was this resetting to '9' on the other instance.
    expect(b1.headers['x-ratelimit-remaining']).toBe('7');
    expect(b1.headers['x-ratelimit-limit']).toBe('10');
  });

  it('clamps X-RateLimit-Remaining at 0 once the shared window is exhausted', async () => {
    setRateLimitStore(new UpstashRateLimitStore(BASE_URL, TOKEN));
    const app = appWithLimiter(1);

    await request(app).get('/probe').expect(200);
    const blocked = await request(app).get('/probe').expect(429);

    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('fails open (serves the request) if the store throws outright', async () => {
    const exploding: IRateLimitStore = {
      get: () => undefined,
      set: () => {},
      delete: () => {},
      entries: () => new Map<string, { count: number; resetAt: number }>().entries(),
      size: 0,
      increment: () => Promise.reject(new Error('store is on fire')),
    };
    setRateLimitStore(exploding);
    const app = appWithLimiter(1);

    // A broken limiter must not take the API down.
    await request(app).get('/probe').expect(200);
    expect(logger.error).toHaveBeenCalled();
  });

  it('still works with the plain in-memory Map store (no increment method)', async () => {
    // Back-compat: the default store is a bare Map and must keep the sync path.
    setRateLimitStore(new Map());
    const app = appWithLimiter(2);

    await request(app).get('/probe').expect(200);
    await request(app).get('/probe').expect(200);
    await request(app).get('/probe').expect(429);
  });

  it('honours the skip predicate before touching Redis', async () => {
    const store = new UpstashRateLimitStore(BASE_URL, TOKEN);
    setRateLimitStore(store);

    const app = express();
    app.use(rateLimit({ windowMs: 60_000, maxRequests: 1, keyGenerator: () => 'skip-key', skip: () => true }));
    app.get('/probe', (_req, res) => {
      res.status(200).json({ ok: true });
    });

    await request(app).get('/probe').expect(200);
    await request(app).get('/probe').expect(200);

    expect(redis.peekCounter(counterKey('skip-key'))).toBeUndefined();
  });
});
