/**
 * BUG-018 / D-8 (follow-up to #2231) — the IDEMPOTENCY keyspace must be
 * namespaced per environment.
 *
 * The second of the two consumers left out of #2231. Production, shared staging
 * and the connector side-rig all bind the SAME un-suffixed
 * `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` secrets, and the key
 * was `idem:` + the caller-supplied `Idempotency-Key`. Nothing in the key
 * identified the environment.
 *
 * The consequence is worse than a shared counter. An idempotency store exists
 * to SUPPRESS a duplicate write, so a collision does not degrade a limit — it
 * silently cancels real work: an `Idempotency-Key` first seen on staging
 * returns staging's cached response to a PRODUCTION caller for the 7200s TTL,
 * and the production write never happens. The caller gets a 2xx and a response
 * body, so nothing surfaces as an error. Anchor-creating routes are exactly the
 * ones that carry idempotency keys.
 *
 * Two shapes of collision are real here, not hypothetical:
 *   - a client library that reuses a deterministic key (a document fingerprint,
 *     a request UUID derived from stable inputs) across a staging dry-run and
 *     the production call;
 *   - E2E/soak fixtures that hammer a fixed key on a rig while production is
 *     serving traffic.
 *
 * The two assertions that must hold AT ONCE:
 *   1. two environments must NOT see each other's idempotency entries, and
 *   2. two instances of the SAME service MUST still share them — that sharing
 *      is the entire point of IDEM-3 (the in-memory Map it replaced did not
 *      dedupe across instances, which is the bug it was written to fix).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { UpstashIdempotencyStore, createUpstashIdempotencyStore } from './upstashIdempotency.js';

const BASE_URL = 'https://fake-redis.upstash.io';
const TOKEN = 'fake-token';
const IDEM_KEY = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

interface CachedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  createdAt: number;
}

function response(body: unknown): CachedResponse {
  return { statusCode: 201, headers: {}, body, createdAt: 0 };
}

/** One Upstash database, shared by every store pointed at it. */
class SharedUpstash {
  private readonly strings = new Map<string, string>();
  readonly keysTouched: string[] = [];

  peek(key: string): string | undefined {
    return this.strings.get(key);
  }

  distinctKeys(): string[] {
    return [...new Set(this.keysTouched)];
  }

  readonly fetch = async (input: string | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    // Split BEFORE decoding: an encoded '/' inside the JSON value must not be
    // read as a path separator.
    const segments = url.slice(BASE_URL.length).replace(/^\//, '').split('/');
    const [cmd, rawKey, rawValue] = segments;
    const key = decodeURIComponent(rawKey ?? '');
    this.keysTouched.push(key);

    switch (cmd) {
      case 'get':
        return new Response(JSON.stringify({ result: this.strings.get(key) ?? null }), { status: 200 });
      case 'set':
        this.strings.set(key, decodeURIComponent(rawValue ?? ''));
        return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
      case 'del':
        this.strings.delete(key);
        return new Response(JSON.stringify({ result: 1 }), { status: 200 });
      default:
        throw new Error(`SharedUpstash: unsupported command ${cmd}`);
    }
  };
}

let redis: SharedUpstash;
const originalEnv = { ...process.env };

/**
 * `set()` and `delete()` are deliberately fire-and-forget so a Redis write
 * never blocks the response. Let the queued write settle before asserting.
 */
async function flushWrites(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Build a store as the given Cloud Run service would construct it at startup.
 * The namespace is derived at construction from the real
 * `resolveEnvironmentNamespace()`, not injected.
 */
function storeForService(kService?: string): UpstashIdempotencyStore {
  process.env.NODE_ENV = 'production'; // rigs AND prod both run this — see D-8
  if (kService === undefined) {
    delete process.env.K_SERVICE;
  } else {
    process.env.K_SERVICE = kService;
  }
  return new UpstashIdempotencyStore(BASE_URL, TOKEN);
}

beforeEach(() => {
  redis = new SharedUpstash();
  vi.stubGlobal('fetch', redis.fetch);
  process.env = { ...originalEnv };
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
});

describe('BUG-018 — idempotency isolation on one shared Upstash database', () => {
  it('does NOT let a staging idempotency entry suppress a production write', async () => {
    const staging = storeForService('arkova-worker-staging');
    staging.set(IDEM_KEY, response({ anchor: 'STAGING FIXTURE' }));
    await flushWrites();

    const prod = storeForService('arkova-worker');

    // The defect: prod sees a hit, returns staging's response body, and the
    // real production write is silently never performed.
    expect(await prod.get(IDEM_KEY)).toBeUndefined();
  });

  it('does NOT let a production entry suppress a staging/rig write', async () => {
    const prod = storeForService('arkova-worker');
    prod.set(IDEM_KEY, response({ anchor: 'PRODUCTION' }));
    await flushWrites();

    const sidecar = storeForService('arkova-worker-connector-sidecar-2026-08-staging');
    expect(await sidecar.get(IDEM_KEY)).toBeUndefined();
  });

  it('writes one distinct Redis key per environment for the same idempotency key', async () => {
    for (const service of [
      'arkova-worker',
      'arkova-worker-staging',
      'arkova-worker-connector-sidecar-2026-08-staging',
    ]) {
      storeForService(service).set(IDEM_KEY, response({ ok: true }));
    }
    await flushWrites();

    // Pre-fix all three collapse onto the single key `idem:<key>`.
    expect(redis.distinctKeys()).toHaveLength(3);
  });

  it('namespaces the key as idem:<env>:<key>', async () => {
    storeForService('arkova-worker').set(IDEM_KEY, response({ ok: true }));
    storeForService('arkova-worker-staging').set(IDEM_KEY, response({ ok: true }));
    await flushWrites();

    expect(redis.peek(`idem:prod:${IDEM_KEY}`)).toBeDefined();
    expect(redis.peek(`idem:arkova-worker-staging:${IDEM_KEY}`)).toBeDefined();
  });

  it('exposes the derived namespace for diagnostics', () => {
    expect(storeForService('arkova-worker').environmentNamespace).toBe('prod');
    expect(storeForService('arkova-worker-staging').environmentNamespace)
      .toBe('arkova-worker-staging');
  });

  it('scopes delete() to its own environment', async () => {
    const prod = storeForService('arkova-worker');
    prod.set(IDEM_KEY, response({ anchor: 'PRODUCTION' }));
    await flushWrites();

    storeForService('arkova-worker-staging').delete(IDEM_KEY);
    await flushWrites();

    expect(await prod.get(IDEM_KEY)).toEqual(response({ anchor: 'PRODUCTION' }));
  });

  it('still deletes within its OWN environment (the namespace must not break IDEM-3)', async () => {
    const prod = storeForService('arkova-worker');
    prod.set(IDEM_KEY, response({ ok: true }));
    await flushWrites();
    prod.delete(IDEM_KEY);
    await flushWrites();

    expect(await prod.get(IDEM_KEY)).toBeUndefined();
  });

  it('does not let a caller-supplied key forge another environment\'s segment', async () => {
    const prod = storeForService('arkova-worker');
    prod.set(IDEM_KEY, response({ anchor: 'PRODUCTION' }));
    await flushWrites();

    // The Idempotency-Key header is fully caller-controlled. A staging caller
    // crafting `prod:<key>` must land under staging's own segment, never
    // production's — the env segment precedes the caller's bytes.
    const staging = storeForService('arkova-worker-staging');
    expect(await staging.get(`prod:${IDEM_KEY}`)).toBeUndefined();

    staging.set(`prod:${IDEM_KEY}`, response({ anchor: 'FORGED' }));
    await flushWrites();
    expect(redis.peek(`idem:prod:${IDEM_KEY}`)).toBe(
      JSON.stringify(response({ anchor: 'PRODUCTION' })),
    );
  });

  it('never lets a bare NODE_ENV=production off Cloud Run into the prod keyspace', async () => {
    const prod = storeForService('arkova-worker');
    prod.set(IDEM_KEY, response({ anchor: 'PRODUCTION' }));
    await flushWrites();

    const local = storeForService(undefined);
    expect(local.environmentNamespace).toBe('local-production');
    expect(await local.get(IDEM_KEY)).toBeUndefined();
  });

  it('keeps a service literally named "prod" out of production\'s keyspace', async () => {
    const real = storeForService('arkova-worker');
    real.set(IDEM_KEY, response({ anchor: 'PRODUCTION' }));
    await flushWrites();

    const impostor = storeForService('prod');
    expect(impostor.environmentNamespace).toBe('prod-nonprod');
    expect(await impostor.get(IDEM_KEY)).toBeUndefined();
  });

  it('derives the namespace through the createUpstashIdempotencyStore factory too', () => {
    process.env.UPSTASH_REDIS_REST_URL = BASE_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;
    process.env.K_SERVICE = 'arkova-worker-staging';
    process.env.NODE_ENV = 'production';

    // The factory is the only construction path index.ts uses, so a namespace
    // wired only into the constructor would ship inert.
    expect(createUpstashIdempotencyStore()?.environmentNamespace)
      .toBe('arkova-worker-staging');
  });
});

describe('IDEM-3 — one environment must still share ONE idempotency store', () => {
  it('lets instance B see an entry recorded by instance A of the same service', async () => {
    // Two Cloud Run instances of `arkova-worker` — prod runs min 2 / max 10.
    // Deduping ACROSS instances is why IDEM-3 replaced the in-memory Map.
    const instanceA = storeForService('arkova-worker');
    instanceA.set(IDEM_KEY, response({ anchor: 'PRODUCTION' }));
    await flushWrites();

    const instanceB = storeForService('arkova-worker');
    expect(await instanceB.get(IDEM_KEY)).toEqual(response({ anchor: 'PRODUCTION' }));
  });

  it('lets instance B delete what instance A recorded', async () => {
    const instanceA = storeForService('arkova-worker');
    instanceA.set(IDEM_KEY, response({ ok: true }));
    await flushWrites();

    const instanceB = storeForService('arkova-worker');
    instanceB.delete(IDEM_KEY);
    await flushWrites();

    expect(await instanceA.get(IDEM_KEY)).toBeUndefined();
  });

  it('lands every instance of one service on exactly one Redis key', async () => {
    for (let i = 0; i < 4; i += 1) {
      storeForService('arkova-worker').set(IDEM_KEY, response({ ok: true }));
    }
    await flushWrites();

    expect(redis.distinctKeys()).toEqual([`idem:prod:${IDEM_KEY}`]);
  });
});
