/**
 * BUG-018 / D-8 (follow-up to #2231) — the VERIFY CACHE keyspace must be
 * namespaced per environment.
 *
 * #2231 namespaced the three rate-limit keyspaces. Two other consumers of the
 * SAME single Upstash database were deliberately left out of that PR and are
 * still global. This file covers the first of them.
 *
 * Production, shared staging and the connector side-rig are all bound to ONE
 * Upstash database via the same un-suffixed `UPSTASH_REDIS_REST_URL` /
 * `UPSTASH_REDIS_REST_TOKEN` secrets, and the cache key was
 * `verify:v5:` + `publicId` — a value that is identical across environments by
 * construction, because a publicId is the SAME public identifier wherever it is
 * queried. Nothing else in the key identifies the environment.
 *
 * Unlike the rate-limit collision this is not a budget problem, it is a
 * CORRECTNESS problem on a public API surface: `GET /api/v1/verify/:publicId`
 * serves a cache hit VERBATIM without re-running `buildVerificationResult`
 * (verify.ts ~line 815), so a verification result computed against the STAGING
 * database can be served to a PRODUCTION caller for the whole 300s TTL, and
 * vice versa. Staging rows are fixtures; production rows are the evidence
 * product. §1.5: the API must state what it actually measured.
 *
 * The two assertions that must hold AT ONCE:
 *
 *   1. two environments must NOT read each other's cached verification, and
 *   2. two instances of the SAME service MUST still share one cache — that
 *      sharing is the entire point of PERF-12 (a per-instance cache would just
 *      be a heap leak with extra steps).
 *
 * Each environment is modelled as a FRESH MODULE INSTANCE (`vi.resetModules()`
 * + re-`import`), not as a mutated env var, because the namespace is memoised
 * at module scope exactly as `_redisConfig` already is. That makes the
 * same-service test genuinely two independent instances rather than one module
 * being asked the same question twice.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const BASE_URL = 'https://fake-redis.upstash.io';
const TOKEN = 'fake-token';
const PUBLIC_ID = 'arkova-pub-7f3a91c4';

/**
 * One Upstash database, shared by every module instance pointed at it —
 * modelling the single real database that prod, staging and the side-rig all
 * bind today.
 */
class SharedUpstash {
  private readonly strings = new Map<string, string>();
  readonly keysTouched: string[] = [];

  peek(key: string): string | undefined {
    return this.strings.get(key);
  }

  /** Every distinct Redis key this database has ever seen. */
  distinctKeys(): string[] {
    return [...new Set(this.keysTouched)];
  }

  readonly fetch = async (input: string | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    // Split BEFORE decoding: an encoded '/' inside a JSON value must not be
    // mistaken for a path separator.
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

type VerifyCacheModule = typeof import('./verifyCache.js');

let redis: SharedUpstash;
const originalEnv = { ...process.env };

/**
 * Load a FRESH `verifyCache` module as the given Cloud Run service would load
 * it at startup. Two calls with the same `kService` model two instances of one
 * service; two calls with different names model two environments.
 *
 * This exercises the real `resolveEnvironmentNamespace()` derivation rather
 * than an injected string.
 */
async function verifyCacheForService(kService?: string): Promise<VerifyCacheModule> {
  vi.resetModules();
  process.env.UPSTASH_REDIS_REST_URL = BASE_URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;
  process.env.NODE_ENV = 'production'; // rigs AND prod both run this — see D-8
  if (kService === undefined) {
    delete process.env.K_SERVICE;
  } else {
    process.env.K_SERVICE = kService;
  }
  return import('./verifyCache.js');
}

beforeEach(() => {
  redis = new SharedUpstash();
  vi.stubGlobal('fetch', redis.fetch);
  process.env = { ...originalEnv };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  process.env = { ...originalEnv };
});

describe('BUG-018 — verify cache isolation on one shared Upstash database', () => {
  it('does NOT serve a staging-computed verification to a production caller', async () => {
    const staging = await verifyCacheForService('arkova-worker-staging');
    await staging.setCachedVerification(PUBLIC_ID, { verified: true, source: 'STAGING FIXTURE' });

    const prod = await verifyCacheForService('arkova-worker');
    const served = await prod.getCachedVerification(PUBLIC_ID);

    // The defect: prod reads staging's fixture answer for a real publicId and
    // serves it verbatim for the full 300s TTL.
    expect(served).toBeNull();
  });

  it('does NOT serve a production verification to a staging/rig caller', async () => {
    const prod = await verifyCacheForService('arkova-worker');
    await prod.setCachedVerification(PUBLIC_ID, { verified: true, source: 'PRODUCTION' });

    const sidecar = await verifyCacheForService('arkova-worker-connector-sidecar-2026-08-staging');
    expect(await sidecar.getCachedVerification(PUBLIC_ID)).toBeNull();
  });

  it('writes one distinct Redis key per environment for the same publicId', async () => {
    for (const service of [
      'arkova-worker',
      'arkova-worker-staging',
      'arkova-worker-connector-sidecar-2026-08-staging',
    ]) {
      const mod = await verifyCacheForService(service);
      await mod.setCachedVerification(PUBLIC_ID, { verified: true });
    }

    // Pre-fix all three collapse onto the single key `verify:v5:<publicId>`.
    expect(redis.distinctKeys()).toHaveLength(3);
  });

  it('namespaces the key as verify:v5:<env>:<publicId>', async () => {
    const prod = await verifyCacheForService('arkova-worker');
    await prod.setCachedVerification(PUBLIC_ID, { verified: true });
    expect(redis.peek(`verify:v5:prod:${PUBLIC_ID}`)).toBeDefined();

    const staging = await verifyCacheForService('arkova-worker-staging');
    await staging.setCachedVerification(PUBLIC_ID, { verified: true });
    expect(redis.peek(`verify:v5:arkova-worker-staging:${PUBLIC_ID}`)).toBeDefined();
  });

  it('scopes invalidation to its own environment — staging must not evict prod', async () => {
    const prod = await verifyCacheForService('arkova-worker');
    await prod.setCachedVerification(PUBLIC_ID, { verified: true, source: 'PRODUCTION' });

    // A revocation processed on staging (jobs/revocation.ts, check-confirmations.ts)
    // must not blow a hole in production's cache for the same publicId.
    const staging = await verifyCacheForService('arkova-worker-staging');
    await staging.invalidateVerificationCache(PUBLIC_ID);

    expect(await prod.getCachedVerification(PUBLIC_ID)).toEqual({
      verified: true,
      source: 'PRODUCTION',
    });
  });

  it('still invalidates its OWN environment (the namespace must not break PERF-12)', async () => {
    const prod = await verifyCacheForService('arkova-worker');
    await prod.setCachedVerification(PUBLIC_ID, { verified: true });
    await prod.invalidateVerificationCache(PUBLIC_ID);

    expect(await prod.getCachedVerification(PUBLIC_ID)).toBeNull();
  });

  it('never lets a bare NODE_ENV=production off Cloud Run into the prod keyspace', async () => {
    const prod = await verifyCacheForService('arkova-worker');
    await prod.setCachedVerification(PUBLIC_ID, { verified: true, source: 'PRODUCTION' });

    // No K_SERVICE: a local shell, a `docker run`, a CI job.
    const local = await verifyCacheForService(undefined);
    expect(await local.getCachedVerification(PUBLIC_ID)).toBeNull();
    expect(redis.peek(`verify:v5:local-production:${PUBLIC_ID}`)).toBeUndefined();

    await local.setCachedVerification(PUBLIC_ID, { verified: true, source: 'LOCAL' });
    expect(redis.peek(`verify:v5:local-production:${PUBLIC_ID}`)).toBeDefined();
    expect(redis.peek(`verify:v5:prod:${PUBLIC_ID}`)).toBe(
      JSON.stringify({ verified: true, source: 'PRODUCTION' }),
    );
  });

  it('keeps a service literally named "prod" out of production\'s keyspace', async () => {
    const real = await verifyCacheForService('arkova-worker');
    await real.setCachedVerification(PUBLIC_ID, { verified: true, source: 'PRODUCTION' });

    const impostor = await verifyCacheForService('prod');
    expect(await impostor.getCachedVerification(PUBLIC_ID)).toBeNull();
  });
});

describe('PR #2223 / PERF-12 — one environment must still share ONE cache', () => {
  it('serves instance B a verification cached by instance A of the same service', async () => {
    // Two Cloud Run instances of `arkova-worker` — prod runs min 2 / max 10.
    const instanceA = await verifyCacheForService('arkova-worker');
    await instanceA.setCachedVerification(PUBLIC_ID, { verified: true, source: 'PRODUCTION' });

    const instanceB = await verifyCacheForService('arkova-worker');
    // If the namespace were derived from anything instance-local (K_REVISION,
    // hostname, pid, a random id) this is the assertion that would fail — the
    // cache would silently stop being shared and every request would hit the DB.
    expect(await instanceB.getCachedVerification(PUBLIC_ID)).toEqual({
      verified: true,
      source: 'PRODUCTION',
    });
  });

  it('lets instance B invalidate what instance A cached', async () => {
    const instanceA = await verifyCacheForService('arkova-worker');
    await instanceA.setCachedVerification(PUBLIC_ID, { verified: true });

    // The revocation job and the verify API routinely run on different instances.
    const instanceB = await verifyCacheForService('arkova-worker');
    await instanceB.invalidateVerificationCache(PUBLIC_ID);

    expect(await instanceA.getCachedVerification(PUBLIC_ID)).toBeNull();
  });

  it('lands every instance of one service on exactly one Redis key', async () => {
    for (let i = 0; i < 4; i += 1) {
      const instance = await verifyCacheForService('arkova-worker');
      await instance.setCachedVerification(PUBLIC_ID, { verified: true });
    }

    expect(redis.distinctKeys()).toEqual([`verify:v5:prod:${PUBLIC_ID}`]);
  });
});
