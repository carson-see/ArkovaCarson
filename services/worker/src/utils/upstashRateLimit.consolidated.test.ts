/**
 * Consolidated rate-limit cluster interaction tests — rc/rate-limit-cluster-2026-08.
 *
 * The wave-1 rate-limit PRs (#2223 shared-state counters, #2224 single-count
 * per limiter instance, #2231 environment-namespaced keyspace, #2238
 * verify-cache/idempotency namespacing) merge textually clean or near-clean,
 * and that is precisely the danger (post-freeze plan, PM-1): each PR's own
 * suite exercises its own change against its own base, so no individual suite
 * ever ran the MERGED semantics. These tests assert the cross-PR invariants
 * the merge could silently break:
 *
 *   (a) #2223 survives #2231 — two instances of the SAME environment still
 *       share ONE counting bucket after the namespace lands in the key.
 *       (A namespace derived from anything instance-local would un-share every
 *       counter and re-open F-1 while every single-store test stayed green.)
 *   (b) #2231 survives #2223 — the same limiter key in DIFFERENT environments
 *       must NOT share a bucket now that #2223 makes every request actually
 *       read and write Redis. (Without the namespace, a staging burst spends
 *       production's budget for that IP — BUG-018 / D-8.)
 *   (c) #2224 survives the distributed path — a request through index.ts's
 *       double-mount shape is counted EXACTLY once against the SHARED counter.
 *       #2224's own red run only ever saw the in-memory synchronous path; the
 *       merged tree routes the same mounts through `enforceShared()`, which is
 *       a code path #2224 never tested and #2223 never double-mounted.
 *   (d) the guard on (c)'s fix: two DIFFERENT limiter instances sharing one
 *       bucket must EACH still charge the shared counter — the de-dupe must
 *       stay per-instance on the distributed path, or the second limiter
 *       silently stops enforcing.
 *
 * Red demonstration (recorded in the RC evidence): run against #2231's head
 * `2b5affd7` (= #2223 + #2231, no #2224), (c) fails with the side-rig stride
 * signature (remaining [8, 6, 4] instead of [9, 8, 7]) while (a), (b) and (d)
 * stay green — i.e. (c) detects exactly the missing-#2224 merge condition.
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
import { rateLimit, setRateLimitStore, stopRateLimitCleanup } from './rateLimit.js';
import { resolveEnvironmentNamespace } from './environmentNamespace.js';

const BASE_URL = 'https://fake-redis.upstash.io';
const TOKEN = 'fake-token';

/**
 * Minimal in-process Upstash REST stand-in: ONE server-side keyspace shared by
 * every store pointed at it, with atomic INCR. Same shape as the fake in
 * `upstashRateLimit.distributed.test.ts`, trimmed to what this file drives.
 */
class FakeUpstash {
  private readonly counters = new Map<string, number>();
  private readonly expiries = new Map<string, number>();
  private readonly strings = new Map<string, string>();

  peekCounter(key: string): number | undefined {
    return this.counters.get(key);
  }

  /** Every live counter key — for asserting how many buckets really exist. */
  counterKeys(): string[] {
    return [...this.counters.keys()];
  }

  private exec(argv: string[]): unknown {
    const [rawCmd, key, ...rest] = argv;
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
      case 'pexpire': {
        if (!this.counters.has(key) && !this.strings.has(key)) return 0;
        this.expiries.set(key, Date.now() + Number(rest[0]));
        return 1;
      }
      case 'get':
        return this.strings.get(key) ?? null;
      case 'set':
        this.strings.set(key, rest[0]);
        return 'OK';
      case 'del': {
        const existed = this.counters.delete(key) || this.strings.delete(key);
        this.expiries.delete(key);
        return existed ? 1 : 0;
      }
      default:
        throw new Error(`FakeUpstash: unsupported command ${rawCmd}`);
    }
  }

  readonly fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!url.startsWith(BASE_URL)) throw new Error(`FakeUpstash: unexpected host ${url}`);

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
 * Environments are derived through the REAL #2231 module from the deployment
 * surface identity (K_SERVICE), never hardcoded — if the derivation changes,
 * these tests must keep asserting the merged behaviour, not a stale prefix.
 */
const PROD_NS = resolveEnvironmentNamespace({ kService: 'arkova-worker' });
const STAGING_NS = resolveEnvironmentNamespace({ kService: 'arkova-worker-staging' });

const counterKey = (ns: string, key: string) => `arkova:rl:${ns}:${key}`;

let redis: FakeUpstash;

/** A store as one Cloud Run instance of the given service would build it. */
const instanceOf = (ns: string) => new UpstashRateLimitStore(BASE_URL, TOKEN, redis.fetch, ns);

beforeEach(() => {
  redis = new FakeUpstash();
});

afterEach(() => {
  setRateLimitStore(new Map());
});

afterAll(() => {
  stopRateLimitCleanup();
});

describe('consolidated rate-limit cluster (#2223 + #2224 + #2231 + #2238 merged tree)', () => {
  it('(a) two instances of the SAME environment share one counting bucket — #2223 semantics survive #2231 namespacing', async () => {
    expect(STAGING_NS).toBe('arkova-worker-staging');

    const instanceA = instanceOf(STAGING_NS);
    const instanceB = instanceOf(STAGING_NS);
    const key = 'ip:203.0.113.7';

    const counts: number[] = [];
    for (const instance of [instanceA, instanceA, instanceA, instanceB, instanceB, instanceB]) {
      const entry = await instance.increment(key, 60_000, Date.now());
      counts.push(entry.count);
    }

    // Instance B continues instance A's count; it does not start its own bucket.
    expect(counts).toEqual([1, 2, 3, 4, 5, 6]);

    // And they did it on ONE namespaced key — the #2231 prefix applied to the
    // #2223 counter, not a second bucket per instance.
    expect(redis.peekCounter(counterKey(STAGING_NS, key))).toBe(6);
    expect(redis.counterKeys()).toEqual([counterKey(STAGING_NS, key)]);
  });

  it('(b) the same limiter key in DIFFERENT environments does NOT share a bucket — #2231 semantics survive #2223 shared enforcement', async () => {
    expect(PROD_NS).toBe('prod');
    expect(PROD_NS).not.toBe(STAGING_NS);

    const staging = instanceOf(STAGING_NS);
    const prod = instanceOf(PROD_NS);
    const key = 'ip:216.183.125.66'; // the bare-IP key shape the side-rig read back raw

    // A 50-request staging burst from an IP that also calls production.
    for (let i = 0; i < 50; i++) await staging.increment(key, 60_000, Date.now());

    // Production's first request must be 1, not 51 — the D-8 red assertion,
    // re-proven on the merged tree.
    const prodEntry = await prod.increment(key, 60_000, Date.now());
    expect(prodEntry.count).toBe(1);

    // Two environments, two keys, no bleed in either direction.
    expect(redis.peekCounter(counterKey(STAGING_NS, key))).toBe(50);
    expect(redis.peekCounter(counterKey(PROD_NS, key))).toBe(1);
    expect(redis.counterKeys().sort()).toEqual(
      [counterKey(PROD_NS, key), counterKey(STAGING_NS, key)].sort()
    );
  });

  it('(c) a request through the double-mounted middleware chain charges the SHARED counter exactly once — #2224 semantics survive on the distributed path', async () => {
    const store = instanceOf(STAGING_NS);
    setRateLimitStore(store);

    const guardKey = 'guard:consolidated-fallthrough';
    const guard = rateLimit({
      windowMs: 60_000,
      maxRequests: 10,
      keyGenerator: () => guardKey,
    });

    // index.ts's exact mount shape: prefixed mount whose router falls through,
    // then the SAME guard instance mounted unprefixed (did:web), then the
    // terminal /api/v1 handler.
    const app = express();
    const badgeRouter = express.Router();
    badgeRouter.get('/badge/:id', (_req, res) => {
      res.status(200).json({ router: 'badge' });
    });
    app.use('/api', guard, badgeRouter);

    const didWebRouter = express.Router();
    didWebRouter.get('/.well-known/did.json', (_req, res) => {
      res.status(200).json({ router: 'did-web' });
    });
    app.use(guard, didWebRouter);

    app.get('/api/v1/probe', (_req, res) => {
      res.status(200).json({ router: 'api-v1' });
    });

    const remaining: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/api/v1/probe').expect(200);
      remaining.push(Number(res.headers['x-ratelimit-remaining']));
    }

    // The un-merged failure signature is the side-rig stride of 2: [8, 6, 4].
    expect(remaining).toEqual([9, 8, 7]);

    // The shared counter agrees: three requests, three INCRs — not six.
    expect(redis.peekCounter(counterKey(STAGING_NS, guardKey))).toBe(3);

    // Both route families are still protected by the same bucket.
    await request(app).get('/.well-known/did.json').expect(200);
    expect(redis.peekCounter(counterKey(STAGING_NS, guardKey))).toBe(4);
  });

  it('(d) two DIFFERENT limiter instances sharing one bucket still EACH charge the shared counter — the de-dupe stays per-instance on the distributed path', async () => {
    const store = instanceOf(STAGING_NS);
    setRateLimitStore(store);

    const sharedKey = 'guard:consolidated-shared-bucket';
    const first = rateLimit({ windowMs: 60_000, maxRequests: 10, keyGenerator: () => sharedKey });
    const second = rateLimit({ windowMs: 60_000, maxRequests: 10, keyGenerator: () => sharedKey });

    const app = express();
    app.use(first);
    app.use(second);
    app.get('/probe', (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const res = await request(app).get('/probe').expect(200);

    // Two distinct limiters, one shared bucket: 2 charges. A "this request was
    // already counted" flag that ignored WHICH limiter counted would show 1 —
    // and would mean the second limiter enforces nothing.
    expect(redis.peekCounter(counterKey(STAGING_NS, sharedKey))).toBe(2);
    expect(Number(res.headers['x-ratelimit-remaining'])).toBe(8);
  });
});
