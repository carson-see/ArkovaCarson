import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { API_V2_SCOPES, type ApiV2Scope } from '../apiScopes.js';
import {
  DEFAULT_V2_SCOPE_RATE_LIMITS,
  MemoryV2RateLimitStore,
  UpstashV2RateLimitStore,
  createV2ApiKeyRateLimit,
  createV2ScopeRateLimit,
  getV2ScopeRateLimitConfig,
  resetV2ApiKeyRateLimit,
} from './rateLimit.js';
import { v2ErrorHandler } from './problem.js';

/**
 * SCRUM-1731 contract lock: the published HakiChain partner brief
 * (Confluence A/42532874 §6) and the OpenAPI spec rely on these exact
 * per-minute limits. If a future change here drifts from the brief,
 * partners get unexpected 429s. This test pins the contract so drift
 * fails at PR time.
 */
describe('SCRUM-1731 — published-brief contract lock', () => {
  it('matches the HakiChain brief §6 per-minute scope limits exactly', () => {
    expect(DEFAULT_V2_SCOPE_RATE_LIMITS).toEqual({
      'read:search': 1_000,
      'read:records': 500,
      'read:orgs': 500,
      'write:anchors': 100,
      'admin:rules': 50,
    });
  });

  it('every API_V2_SCOPES entry has a default limit (no scope can be unlimited)', () => {
    for (const scope of API_V2_SCOPES) {
      expect(DEFAULT_V2_SCOPE_RATE_LIMITS).toHaveProperty(scope);
      expect(DEFAULT_V2_SCOPE_RATE_LIMITS[scope]).toBeGreaterThan(0);
    }
  });
});

vi.mock('../../config.js', () => ({
  config: { nodeEnv: 'test' },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../middleware/errorSanitizer.js', () => ({
  sanitizeErrorMessage: (m: string) => m,
}));

function buildApp(now: () => number) {
  const app = express();
  app.use((req, _res, next) => {
    req.apiKey = {
      keyId: 'key-1',
      orgId: 'org-1',
      userId: 'user-1',
      scopes: ['read:search'],
      rateLimitTier: 'paid',
      keyPrefix: 'ak_test_',
    };
    next();
  });
  app.use(createV2ApiKeyRateLimit({ maxRequests: 2, windowMs: 60_000, now }));
  app.get('/search', (_req, res) => res.json({ ok: true }));
  app.use(v2ErrorHandler);
  return app;
}

function buildScopedApp(scope: ApiV2Scope, now: () => number, quota = 2) {
  const app = express();
  const store = new MemoryV2RateLimitStore();
  app.use((req, _res, next) => {
    req.apiKey = {
      keyId: 'key-1',
      orgId: 'org-1',
      userId: 'user-1',
      scopes: [scope],
      rateLimitTier: 'paid',
      keyPrefix: 'ak_test_',
    };
    next();
  });
  app.get('/probe', createV2ScopeRateLimit(scope, {
    quotas: { [scope]: quota },
    windowMs: 60_000,
    now,
    store,
  }), (_req, res) => res.json({ ok: true }));
  app.use(v2ErrorHandler);
  return app;
}

describe('createV2ApiKeyRateLimit', () => {
  beforeEach(() => {
    resetV2ApiKeyRateLimit();
  });

  it('allows requests within the API key policy and emits rate headers', async () => {
    const app = buildApp(() => 1_000);

    const res = await request(app).get('/search');

    expect(res.status).toBe(200);
    expect(res.header['x-ratelimit-limit']).toBe('2');
    expect(res.header['x-ratelimit-remaining']).toBe('1');
  });

  it('returns RFC 7807 problem+json when the key exceeds its minute bucket', async () => {
    const app = buildApp(() => 1_000);

    await request(app).get('/search');
    await request(app).get('/search');
    const res = await request(app).get('/search');

    expect(res.status).toBe(429);
    expect(res.type).toBe('application/problem+json');
    expect(res.header['retry-after']).toBe('60');
    expect(res.body.type).toContain('/rate-limited');
  });
});

describe('scope-aware v2 rate limits', () => {
  it('uses the documented default per-scope quotas', () => {
    expect(getV2ScopeRateLimitConfig({})).toEqual(DEFAULT_V2_SCOPE_RATE_LIMITS);
  });

  it('allows env overrides without changing unspecified defaults', () => {
    expect(getV2ScopeRateLimitConfig({
      API_V2_RATE_LIMIT_READ_RECORDS_PER_MIN: '750',
      API_V2_RATE_LIMIT_ADMIN_RULES_PER_MIN: '25',
    })).toMatchObject({
      'read:search': 1_000,
      'read:records': 750,
      'read:orgs': 500,
      'write:anchors': 100,
      'admin:rules': 25,
    });
  });

  it.each(API_V2_SCOPES)('enforces threshold and reset for %s', async (scope) => {
    let now = 1_000;
    const app = buildScopedApp(scope, () => now);

    await request(app).get('/probe').expect(200);
    const second = await request(app).get('/probe').expect(200);
    expect(second.header['x-ratelimit-limit']).toBe('2');
    expect(second.header['x-ratelimit-remaining']).toBe('0');

    const blocked = await request(app).get('/probe').expect(429);
    expect(blocked.header['retry-after']).toBe('60');
    expect(blocked.header['x-ratelimit-remaining']).toBe('0');
    expect(blocked.body.type).toContain('/rate-limited');

    now += 60_001;
    const reset = await request(app).get('/probe').expect(200);
    expect(reset.header['x-ratelimit-remaining']).toBe('1');
  });
});

describe('SCRUM-1225: MemoryV2RateLimitStore evicts expired entries', () => {
  // Read-only window helper since the store doesn't expose entry keys
  // directly. We check survival by re-incrementing and asserting the
  // returned `count` (1 for new entries, >1 for kept entries). Together
  // with size(), this proves the IDENTITY of survivors, not just the count.
  async function survives(store: MemoryV2RateLimitStore, key: string, now: () => number): Promise<boolean> {
    const e = await store.increment(key, 60_000, now);
    return e.count > 1;
  }

  it('purges expired entries and keeps only the post-window key', async () => {
    const store = new MemoryV2RateLimitStore();
    let now = 1_000;
    for (let i = 0; i < 100; i++) {
      await store.increment(`key-${i}`, 60_000, () => now);
    }
    expect(store.size()).toBe(100);

    now += 70_000;
    await store.increment('post-window', 60_000, () => now);
    expect(store.size()).toBe(1);

    // The single survivor must be 'post-window' — re-incrementing it should
    // see count===2; re-incrementing any pre-window key should see count===1.
    expect(await survives(store, 'post-window', () => now)).toBe(true);
    expect(await survives(store, 'key-0', () => now)).toBe(false);
    expect(await survives(store, 'key-99', () => now)).toBe(false);
  });

  it('keeps live entries (within window) across the sweep', async () => {
    const store = new MemoryV2RateLimitStore();
    let now = 1_000;
    await store.increment('alive-1', 60_000, () => now);
    await store.increment('alive-2', 60_000, () => now);

    now += 30_000;
    await store.increment('alive-3', 60_000, () => now);
    expect(store.size()).toBe(3);

    // Identity check: all three names must be present.
    expect(await survives(store, 'alive-1', () => now)).toBe(true);
    expect(await survives(store, 'alive-2', () => now)).toBe(true);
    expect(await survives(store, 'alive-3', () => now)).toBe(true);
  });

  it('SCRUM-1225 hard cap: forces eviction down to 90% even within sweep window', async () => {
    // Vitest pushes 50K iterations to ~1s; the hard cap is the safety net for
    // a real burst of unique keys arriving inside a single sweep window.
    // Use a window LONGER than the sweep interval so the time-based purge
    // can't fire — only the hard-cap path runs.
    const store = new MemoryV2RateLimitStore();
    const longWindow = 600_000; // 10 min — much longer than sweep interval
    let now = 1_000;

    // Push past the 50K hard cap. Use small steps so resetAt differs and the
    // sort-by-resetAt eviction can pick "oldest" correctly.
    for (let i = 0; i < 50_001; i++) {
      await store.increment(`burst-${i}`, longWindow, () => now);
      now += 1; // ensure each entry has a distinct resetAt
    }

    // After crossing the cap the store must drop to ~90% (45K), not 50,001.
    // Off-by-one is fine: eviction fires before the final entry is added.
    expect(store.size()).toBeLessThan(46_000);
    expect(store.size()).toBeGreaterThan(40_000);

    // The earliest entries (smallest resetAt) must have been evicted.
    expect(await survives(store, 'burst-0', () => now)).toBe(false);
    // The latest entries must have survived.
    expect(await survives(store, 'burst-50000', () => now)).toBe(true);
  });
});

/**
 * BUG-018 / D-8 — the v2 keyspace has the same environment-collision defect as
 * the v1 limiter, and unlike v1 it is NOT inert: `UpstashV2RateLimitStore`
 * already reads and writes Redis on every request today, so prod and every
 * staging surface bound to the one shared Upstash database have been sharing
 * `arkova:v2:ratelimit:<key>` all along. Fixing only v1 would leave v2 as the
 * remaining hole in the same database.
 */
describe('BUG-018 — v2 rate-limit keyspace is namespaced per environment', () => {
  const BASE = 'https://fake.upstash.io';

  /** One shared Upstash database, as prod + staging + the side-rig all bind. */
  function sharedUpstash() {
    const counters = new Map<string, number>();
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const [command, key] = url
        .replace(`${BASE}/`, '')
        .split('/')
        .map(decodeURIComponent);

      let result: number;
      switch (command) {
        case 'incr':
          result = (counters.get(key) ?? 0) + 1;
          counters.set(key, result);
          break;
        case 'pexpire':
          result = 1;
          break;
        case 'pttl':
          result = 60_000;
          break;
        default:
          throw new Error(`unsupported command ${command}`);
      }
      return new Response(JSON.stringify({ result }), { status: 200 });
    };
    return { counters, fetchImpl };
  }

  it('an API key burst on staging does not consume that key\'s production budget', async () => {
    const { counters, fetchImpl } = sharedUpstash();
    const prod = new UpstashV2RateLimitStore(BASE, 'tok', fetchImpl, 'prod');
    const staging = new UpstashV2RateLimitStore(BASE, 'tok', fetchImpl, 'arkova-worker-staging');
    const key = 'apikey:ak_live_2a54';

    for (let i = 0; i < 900; i++) await staging.increment(key, 60_000, () => Date.now());
    const first = await prod.increment(key, 60_000, () => Date.now());

    expect(first.count).toBe(1);
    expect(counters.get(`arkova:v2:ratelimit:prod:${key}`)).toBe(1);
    expect(counters.get(`arkova:v2:ratelimit:arkova-worker-staging:${key}`)).toBe(900);
    // The pre-fix shape — one global key serving every environment.
    expect(counters.get(`arkova:v2:ratelimit:${key}`)).toBeUndefined();
  });

  it('two instances of the SAME service still share one v2 bucket', async () => {
    const { counters, fetchImpl } = sharedUpstash();
    const a = new UpstashV2RateLimitStore(BASE, 'tok', fetchImpl, 'prod');
    const b = new UpstashV2RateLimitStore(BASE, 'tok', fetchImpl, 'prod');
    const key = 'apikey:shared';

    await a.increment(key, 60_000, () => Date.now());
    const second = await b.increment(key, 60_000, () => Date.now());

    expect(second.count).toBe(2);
    expect(counters.get(`arkova:v2:ratelimit:prod:${key}`)).toBe(2);
  });

  it('defaults the namespace to the deployment surface when none is passed', async () => {
    const { counters, fetchImpl } = sharedUpstash();
    const prev = process.env.K_SERVICE;
    process.env.K_SERVICE = 'arkova-worker-staging';
    try {
      const store = new UpstashV2RateLimitStore(BASE, 'tok', fetchImpl);
      await store.increment('apikey:derived', 60_000, () => Date.now());
      expect(counters.get('arkova:v2:ratelimit:arkova-worker-staging:apikey:derived')).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.K_SERVICE;
      else process.env.K_SERVICE = prev;
    }
  });
});
