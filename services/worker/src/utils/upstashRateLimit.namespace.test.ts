/**
 * BUG-018 / D-8 — the rate-limit keyspace must be namespaced per environment.
 *
 * The finding (FULLSOAK 2026-08, gap-closure run 2026-08-13): production,
 * shared staging and the connector side-rig are all bound to ONE Upstash
 * database via the same un-suffixed `UPSTASH_REDIS_REST_URL` /
 * `UPSTASH_REDIS_REST_TOKEN` secrets, and the counter key was
 * `arkova:rl:` + the limiter key — which for the per-IP shadow guard is the
 * bare client IP. Nothing else in the key identifies the environment.
 *
 * That was inert only for as long as the limiter never actually read Redis.
 * PR #2223 makes it read and write Redis on every request, so from the moment
 * #2223 lands a burst against shared staging from an IP that also calls
 * production consumes PRODUCTION's budget for that IP, and vice versa. This
 * file is the pair of assertions that must both hold at once:
 *
 *   1. two instances in DIFFERENT environments must NOT share a bucket (BUG-018);
 *   2. two instances in the SAME environment MUST still share one (PR #2223's
 *      entire point — a namespace that also broke cross-instance sharing would
 *      be a regression dressed as a fix).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { UpstashRateLimitStore, initUpstashRateLimiting } from './upstashRateLimit.js';
import { setRateLimitStore, stopRateLimitCleanup, rateLimit } from './rateLimit.js';
import { PROD_NAMESPACE, PROD_SERVICE_NAME } from './environmentNamespace.js';
import { logger } from './logger.js';
import express from 'express';
import request from 'supertest';

const BASE_URL = 'https://fake-redis.upstash.io';
const TOKEN = 'fake-token';

/**
 * One Upstash database, shared by every store pointed at it — modelling the
 * single real database that prod, staging and the side-rig all bind today.
 */
class SharedUpstash {
  private readonly counters = new Map<string, number>();
  private readonly strings = new Map<string, string>();
  private readonly expiries = new Map<string, number>();
  readonly keysTouched: string[] = [];

  peek(key: string): number | undefined {
    return this.counters.get(key);
  }

  peekString(key: string): string | undefined {
    return this.strings.get(key);
  }

  /** Every distinct Redis key this database has ever seen. */
  distinctKeys(): string[] {
    return [...new Set(this.keysTouched)];
  }

  private exec(argv: string[]): unknown {
    const [rawCmd, key, ...rest] = argv;
    this.keysTouched.push(key);

    switch (rawCmd.toLowerCase()) {
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
      case 'pttl': {
        if (!this.counters.has(key)) return -2;
        const expiry = this.expiries.get(key);
        return expiry === undefined ? -1 : expiry - Date.now();
      }
      case 'pexpire':
        this.expiries.set(key, Date.now() + Number(rest[0]));
        return 1;
      case 'get':
        return this.strings.get(key) ?? null;
      case 'set':
        this.strings.set(key, rest[0]);
        return 'OK';
      case 'del':
        return (this.counters.delete(key) || this.strings.delete(key)) ? 1 : 0;
      default:
        throw new Error(`SharedUpstash: unsupported command ${rawCmd}`);
    }
  }

  readonly fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = url.slice(BASE_URL.length).replace(/^\//, '');

    if (path === 'pipeline') {
      const commands = JSON.parse(String(init?.body ?? '[]')) as string[][];
      return new Response(
        JSON.stringify(commands.map((argv) => ({ result: this.exec(argv.map(String)) }))),
        { status: 200 },
      );
    }

    const argv = path.split('/').map(decodeURIComponent);
    return new Response(JSON.stringify({ result: this.exec(argv) }), { status: 200 });
  };
}

let redis: SharedUpstash;
const originalEnv = { ...process.env };

/** Build a store as the given Cloud Run service would construct it at startup. */
function storeForService(kService: string): UpstashRateLimitStore {
  process.env.K_SERVICE = kService;
  process.env.NODE_ENV = 'production';
  // Namespace is derived at construction, exactly as `initUpstashRateLimiting`
  // does it — this exercises the real derivation, not an injected string.
  return new UpstashRateLimitStore(BASE_URL, TOKEN);
}

beforeEach(() => {
  redis = new SharedUpstash();
  vi.stubGlobal('fetch', redis.fetch);
  process.env = { ...originalEnv };
  vi.mocked(logger.info).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
  setRateLimitStore(new Map());
  stopRateLimitCleanup();
});

describe('BUG-018 — cross-environment isolation on one shared Upstash database', () => {
  it('prod and shared staging do NOT share a bucket for the same client IP', async () => {
    const prod = storeForService(PROD_SERVICE_NAME);
    const staging = storeForService('arkova-worker-staging');
    const ip = '216.183.125.66'; // the real egress IP from the side-rig capture
    const windowMs = 60_000;

    // Staging burns 50 requests from that IP.
    for (let i = 0; i < 50; i++) await staging.increment(ip, windowMs, Date.now());

    // Production's very first request from the same IP must be #1, not #51.
    const first = await prod.increment(ip, windowMs, Date.now());
    expect(first.count).toBe(1);

    // Two distinct Redis keys, one per environment.
    expect(redis.peek(`arkova:rl:${PROD_NAMESPACE}:${ip}`)).toBe(1);
    expect(redis.peek(`arkova:rl:arkova-worker-staging:${ip}`)).toBe(50);
  });

  it('the side-rig cannot exhaust production\'s budget (the D-8 blast radius, directly)', async () => {
    const prod = storeForService(PROD_SERVICE_NAME);
    const sidecar = storeForService('arkova-worker-connector-sidecar-2026-08-staging');
    const ip = '198.51.100.7';
    const windowMs = 60_000;
    const maxRequests = 60;

    // A 200-request soak burst against the side-rig — the exact GAP 3 probe.
    for (let i = 0; i < 200; i++) await sidecar.increment(ip, windowMs, Date.now());

    const prodEntry = await prod.increment(ip, windowMs, Date.now());
    expect(prodEntry.count).toBeLessThanOrEqual(maxRequests);
    expect(prodEntry.count).toBe(1);
  });

  it('three environments produce three keys, and none of them is the bare limiter key', async () => {
    const ip = '203.0.113.11';
    for (const svc of [
      PROD_SERVICE_NAME,
      'arkova-worker-staging',
      'arkova-worker-connector-sidecar-2026-08-staging',
    ]) {
      await storeForService(svc).increment(ip, 60_000, Date.now());
    }

    const counterKeys = redis.distinctKeys().filter((k) => k.startsWith('arkova:rl:'));
    expect(counterKeys).toHaveLength(3);
    // The pre-fix shape: `arkova:rl:` + the bare IP, identical in every environment.
    expect(counterKeys).not.toContain(`arkova:rl:${ip}`);
    for (const key of counterKeys) {
      expect(key.endsWith(`:${ip}`)).toBe(true);
    }
  });

  it('namespaces the legacy blob keyspace too — a bare IP was a global Redis key', async () => {
    // The side-rig capture read `GET {upstash}/get/216.183.125.66` and got a
    // hit: set()/delete() wrote the raw limiter key with no prefix at all, so
    // every environment shared one unqualified `216.183.125.66` key.
    const prod = storeForService(PROD_SERVICE_NAME);
    const staging = storeForService('arkova-worker-staging');
    const ip = '216.183.125.66';

    prod.set(ip, { count: 7, resetAt: Date.now() + 60_000 });
    staging.set(ip, { count: 99, resetAt: Date.now() + 60_000 });
    await new Promise((r) => setTimeout(r, 10));

    expect(redis.peekString(ip)).toBeUndefined();
    expect(redis.peekString(`arkova:rl:blob:${PROD_NAMESPACE}:${ip}`)).toContain('"count":7');
    expect(redis.peekString(`arkova:rl:blob:arkova-worker-staging:${ip}`)).toContain('"count":99');
  });

  it('a local shell running NODE_ENV=production never writes into production\'s keyspace', async () => {
    delete process.env.K_SERVICE;
    process.env.NODE_ENV = 'production';
    const local = new UpstashRateLimitStore(BASE_URL, TOKEN);

    await local.increment('203.0.113.12', 60_000, Date.now());

    expect(redis.peek(`arkova:rl:${PROD_NAMESPACE}:203.0.113.12`)).toBeUndefined();
    expect(redis.peek('arkova:rl:local-production:203.0.113.12')).toBe(1);
  });

  it('decrement releases a slot in the caller\'s OWN namespace only', async () => {
    const prod = storeForService(PROD_SERVICE_NAME);
    const staging = storeForService('arkova-worker-staging');
    const ip = '203.0.113.13';

    await prod.increment(ip, 60_000, Date.now());
    await prod.increment(ip, 60_000, Date.now());
    await staging.increment(ip, 60_000, Date.now());

    await staging.decrement(ip);

    expect(redis.peek(`arkova:rl:${PROD_NAMESPACE}:${ip}`)).toBe(2);
    expect(redis.peek(`arkova:rl:arkova-worker-staging:${ip}`)).toBe(0);
  });
});

describe('PR #2223 regression guard — same-environment sharing survives the namespace', () => {
  it('two instances of the SAME service still enforce ONE combined bucket', async () => {
    // The load-bearing property of #2223. A namespace derived from anything
    // instance-local (K_REVISION, hostname, a random id) would silently undo it.
    const instanceA = storeForService(PROD_SERVICE_NAME);
    const instanceB = storeForService(PROD_SERVICE_NAME);
    const ip = '203.0.113.20';

    const counts: number[] = [];
    for (const instance of [instanceA, instanceA, instanceA, instanceB, instanceB, instanceB]) {
      counts.push((await instance.increment(ip, 60_000, Date.now())).count);
    }

    expect(counts).toEqual([1, 2, 3, 4, 5, 6]);
    expect(redis.peek(`arkova:rl:${PROD_NAMESPACE}:${ip}`)).toBe(6);
    // One key for both instances — not two.
    expect(redis.distinctKeys().filter((k) => k.startsWith('arkova:rl:'))).toHaveLength(1);
  });

  it('a cold-started instance of the same service still inherits the accrued count', async () => {
    const warm = storeForService('arkova-worker-staging');
    const ip = '203.0.113.21';
    for (let i = 0; i < 40; i++) await warm.increment(ip, 60_000, Date.now());

    const cold = storeForService('arkova-worker-staging');
    expect((await cold.increment(ip, 60_000, Date.now())).count).toBe(41);
  });

  it('through the middleware: instance B is blocked by instance A traffic, and staging is not', async () => {
    const app = express();
    app.set('trust proxy', true);
    app.use(rateLimit({ windowMs: 60_000, maxRequests: 3, keyGenerator: () => 'fixed-key' }));
    app.get('/probe', (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const prodA = storeForService(PROD_SERVICE_NAME);
    const prodB = storeForService(PROD_SERVICE_NAME);
    const staging = storeForService('arkova-worker-staging');

    setRateLimitStore(prodA);
    await request(app).get('/probe').expect(200);
    await request(app).get('/probe').expect(200);

    setRateLimitStore(prodB);
    await request(app).get('/probe').expect(200); // 3rd overall on the shared prod bucket
    await request(app).get('/probe').expect(429); // 4th — refused across instances

    // Staging is a different bucket entirely and is still wide open.
    setRateLimitStore(staging);
    await request(app).get('/probe').expect(200);
  });
});

describe('initUpstashRateLimiting — namespace is visible to the operator', () => {
  it('logs the namespace the service will write under', () => {
    process.env.UPSTASH_REDIS_REST_URL = BASE_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;
    process.env.K_SERVICE = 'arkova-worker-staging';

    expect(initUpstashRateLimiting()).toBe(true);

    // Without this in the log there is no way to tell, from a running service,
    // which keyspace it is actually sharing — the condition that let D-8 sit
    // undetected across three environments.
    const logged = vi.mocked(logger.info).mock.calls.map((c) => JSON.stringify(c)).join(' ');
    expect(logged).toContain('arkova-worker-staging');
  });
});
