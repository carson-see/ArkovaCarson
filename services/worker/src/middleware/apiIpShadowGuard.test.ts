/**
 * `apiIpShadowGuard` — the broad 60/min-per-IP guard that `index.ts` mounts in
 * front of every `/api/*` route (and, prefix-less, in front of the did:web /
 * proof-keys routers).
 *
 * Two behaviours are pinned here:
 *
 * 1. **F-2** (already shipped): `/api/v1/*` requests that carry an API key
 *    credential skip this guard, because `apiV1Router`'s keyed limiter
 *    (1,000/min/key) is the one that owns them.
 *
 * 2. **SCRUM-2603 / §1.10**: anonymous public verification traffic also skips
 *    it. `/api/v1/verify` is contractually 100 req/min per IP, and
 *    `apiV1Router`'s `anonRateLimiter` enforces exactly that — but requests
 *    never reached it with an unspent budget, because this 60/min guard runs
 *    first (twice, from its two mounts). The verify surface was therefore
 *    capped well under the contract. Skipping the guard for that one public
 *    prefix hands the contract back to the limiter that implements it; verify
 *    is NOT unlimited, it is 100/min/IP downstream.
 *
 * The predicate is exported and unit-tested separately from the wiring, the
 * same way `routes/admin-paths.ts` splits `isAdminRouterPath` out of
 * `adminRouter`. The supertest cases below mount the REAL `apiIpShadowGuard`
 * instance with its real 60/min config in the same shape `index.ts` uses (a
 * `/api`-prefixed mount plus a prefix-less mount), so the guard under test is
 * production code, not a re-declaration of it.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import supertest from 'supertest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  API_IP_SHADOW_GUARD_MAX_PER_MIN,
  PUBLIC_VERIFY_ANON_MAX_PER_MIN,
  apiIpShadowGuard,
  hasApiKeyCredential,
  isPublicVerifyPath,
  publicVerifyAnonLimiter,
  shouldSkipApiIpShadowGuard,
} from './apiIpShadowGuard.js';

/** §1.10 anonymous contract for the public verification API. */
const ANON_CONTRACT_PER_MIN = 100;

function fakeReq(originalUrl: string, headers: Record<string, unknown> = {}): Request {
  return { originalUrl, headers } as unknown as Request;
}

/**
 * Mirrors `index.ts`'s mount shape: the guard runs on `/api/*` (in front of
 * badgeRouter) AND prefix-less (in front of didWebRouter + proofKeysRouter),
 * so an `/api/**` request traverses the same instance twice.
 */
function buildApp() {
  const app = express();
  app.set('trust proxy', true); // X-Forwarded-For -> req.ip, so each test owns a bucket
  app.use('/api/v1/verify', publicVerifyAnonLimiter);
  app.use('/api', apiIpShadowGuard, express.Router());
  app.use(apiIpShadowGuard, express.Router());
  app.use((_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

/**
 * The `ENABLE_VERIFICATION_API`-off shape. `apiV1Router`'s `verificationApiGate`
 * runs BEFORE its `anonRateLimiter`, so with the flag off a verify request 503s
 * without ever reaching that limiter. The verify carve-out must therefore not
 * depend on it: `publicVerifyAnonLimiter` is mounted above the feature gate and
 * is what actually holds the §1.10 anon line.
 */
function buildDarkApiApp() {
  const app = express();
  app.set('trust proxy', true);
  app.use('/api/v1/verify', publicVerifyAnonLimiter);
  app.use('/api', apiIpShadowGuard, express.Router());
  app.use(apiIpShadowGuard, express.Router());
  app.use('/api/v1', (_req: Request, res: Response) => {
    // Stand-in for verificationApiGate()'s 503 when the flag is off.
    res.status(503).json({ error: 'service_unavailable' });
  });
  return app;
}

let ipCounter = 0;
/** TEST-NET-3 (RFC 5737) — one bucket per test; the limiter store is module-global. */
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

describe('isPublicVerifyPath', () => {
  it.each([
    '/api/v1/verify',
    '/api/v1/verify/ARK-2026-ABC123',
    '/api/v1/verify/ARK-2026-ABC123/proof',
    '/api/v1/verify/attestation/ARK-2026-ABC123',
    '/api/v1/verify?pretty=1',
    // Express's `case sensitive routing` is OFF by default, so these reach the
    // verify handlers and `publicVerifyAnonLimiter` exactly like the lower-case
    // form. If the predicate missed them the 60/min guard would count them
    // (twice, from its two mounts) and put that URL form back on the ~30/min
    // SCRUM-2603 ceiling.
    '/API/V1/VERIFY/ARK-2026-ABC123',
    '/Api/V1/Verify',
  ])('matches the public verification surface: %s', (url) => {
    expect(isPublicVerifyPath(url)).toBe(true);
  });

  it.each([
    '/api/v1/verifyer',
    '/api/v1/verification',
    '/api/v1/verify-anchor',
    '/API/V1/VERIFY-ANCHOR',
    '/api/v1/org',
    '/api/verify-anchor',
    '/api/badge/ARK-2026-ABC123',
    '/',
    '',
  ])('does not bleed onto a neighbouring path: %s', (url) => {
    expect(isPublicVerifyPath(url)).toBe(false);
  });
});

describe('hasApiKeyCredential', () => {
  it('detects a Bearer ak_ credential', () => {
    expect(hasApiKeyCredential(fakeReq('/api/v1/org', { authorization: 'Bearer ak_live_x' }))).toBe(true);
  });

  it('detects an X-API-Key ak_ credential', () => {
    expect(hasApiKeyCredential(fakeReq('/api/v1/org', { 'x-api-key': 'ak_live_x' }))).toBe(true);
  });

  it('rejects a Supabase JWT bearer token', () => {
    expect(hasApiKeyCredential(fakeReq('/api/v1/org', { authorization: 'Bearer eyJhbGciOi' }))).toBe(false);
  });

  it('rejects a non-string header value', () => {
    expect(hasApiKeyCredential(fakeReq('/api/v1/org', { 'x-api-key': ['ak_live_x'] }))).toBe(false);
  });

  it('rejects a request with no credential at all', () => {
    expect(hasApiKeyCredential(fakeReq('/api/v1/verify/ARK-X'))).toBe(false);
  });
});

describe('shouldSkipApiIpShadowGuard', () => {
  it('skips anonymous public verify reads (§1.10 hands them to the 100/min anon limiter)', () => {
    expect(shouldSkipApiIpShadowGuard(fakeReq('/api/v1/verify/ARK-2026-ABC123'))).toBe(true);
  });

  it('skips keyed /api/v1 traffic (F-2)', () => {
    expect(
      shouldSkipApiIpShadowGuard(fakeReq('/api/v1/org', { authorization: 'Bearer ak_live_x' })),
    ).toBe(true);
  });

  it('still guards anonymous non-verify /api/v1 traffic', () => {
    expect(shouldSkipApiIpShadowGuard(fakeReq('/api/v1/org'))).toBe(false);
  });

  it('still guards keyed traffic outside /api/v1', () => {
    // The F-2 carve-out is deliberately narrow: only `/api/v1/*` has a
    // downstream per-key limiter to defer to.
    expect(
      shouldSkipApiIpShadowGuard(fakeReq('/api/checkout/session', { authorization: 'Bearer ak_live_x' })),
    ).toBe(false);
  });

  it('still guards anonymous badge traffic', () => {
    expect(shouldSkipApiIpShadowGuard(fakeReq('/api/badge/ARK-2026-ABC123'))).toBe(false);
  });

  it('skips a case-varied verify path, because Express routes it to verify anyway', () => {
    expect(shouldSkipApiIpShadowGuard(fakeReq('/API/v1/verify/ARK-2026-ABC123'))).toBe(true);
  });

  it('skips case-varied keyed /api/v1 traffic (F-2)', () => {
    expect(
      shouldSkipApiIpShadowGuard(fakeReq('/API/V1/org', { authorization: 'Bearer ak_live_x' })),
    ).toBe(true);
  });
});

describe('apiIpShadowGuard wiring (index.ts mount shape)', () => {
  it('never 429s anonymous verify traffic inside the §1.10 contract', async () => {
    // The 60/min guard must not be the limiter that binds verify. Requests
    // inside the 100/min contract must all pass, and the first rejection past
    // it must advertise the contract (100) rather than the guard's 60 — a 429
    // carrying `X-RateLimit-Limit: 60` means the guard is shadowing again.
    const app = buildApp();
    const ip = nextIp();
    const inContract: number[] = [];

    for (let i = 0; i < ANON_CONTRACT_PER_MIN; i++) {
      const res = await supertest(app)
        .get('/api/v1/verify/ARK-2026-ABC123')
        .set('X-Forwarded-For', ip);
      inContract.push(res.status);
    }

    const rejected = inContract.filter((s) => s === 429);
    expect(
      rejected.length,
      `the 60/min IP guard must not bind the ${ANON_CONTRACT_PER_MIN}/min public verify ` +
        `contract; got ${rejected.length} 429(s) inside it`,
    ).toBe(0);

    const over = await supertest(app)
      .get('/api/v1/verify/ARK-2026-ABC123')
      .set('X-Forwarded-For', ip);
    expect(over.status).toBe(429);
    expect(
      over.headers['x-ratelimit-limit'],
      'the binding limiter must be the anon contract, not the 60/min IP guard',
    ).toBe(String(ANON_CONTRACT_PER_MIN));
  });

  it('still caps anonymous non-verify /api traffic at its own 60/min bucket', async () => {
    const app = buildApp();
    const ip = nextIp();
    let limited: Awaited<ReturnType<ReturnType<typeof supertest>['get']>> | null = null;

    for (let i = 0; i < API_IP_SHADOW_GUARD_MAX_PER_MIN + 1; i++) {
      const res = await supertest(app).get('/api/badge/ARK-2026-ABC123').set('X-Forwarded-For', ip);
      if (res.status === 429) {
        limited = res;
        break;
      }
    }

    expect(limited, 'anonymous badge traffic must still hit the 60/min guard').not.toBeNull();
    expect(limited!.headers['retry-after']).toBeDefined();
    expect(limited!.headers['x-ratelimit-limit']).toBe(String(API_IP_SHADOW_GUARD_MAX_PER_MIN));
  });

  it('still lets keyed /api/v1 traffic past the guard (F-2 regression)', async () => {
    const app = buildApp();
    const ip = nextIp();
    const statuses: number[] = [];

    for (let i = 0; i < API_IP_SHADOW_GUARD_MAX_PER_MIN + 20; i++) {
      const res = await supertest(app)
        .get('/api/v1/org')
        .set('X-Forwarded-For', ip)
        .set('Authorization', 'Bearer ak_live_testkey');
      statuses.push(res.status);
    }

    expect(statuses.filter((s) => s === 429).length).toBe(0);
  });

  it('still caps anonymous non-verify /api/v1 traffic', async () => {
    const app = buildApp();
    const ip = nextIp();
    let saw429 = false;

    for (let i = 0; i < API_IP_SHADOW_GUARD_MAX_PER_MIN + 1; i++) {
      const res = await supertest(app).get('/api/v1/org').set('X-Forwarded-For', ip);
      if (res.status === 429) {
        saw429 = true;
        break;
      }
    }

    expect(saw429, 'anonymous /api/v1/org must still be guarded at 60/min').toBe(true);
  });
});

describe('publicVerifyAnonLimiter (\u00a71.10 anonymous verify tier)', () => {
  it('allows exactly the contract budget and 429s the request after it', async () => {
    const app = buildApp();
    const ip = nextIp();

    for (let i = 0; i < PUBLIC_VERIFY_ANON_MAX_PER_MIN; i++) {
      const res = await supertest(app)
        .get('/api/v1/verify/ARK-2026-ABC123')
        .set('X-Forwarded-For', ip);
      expect(res.status, `verify request ${i + 1} must be inside the contract`).not.toBe(429);
    }

    const over = await supertest(app)
      .get('/api/v1/verify/ARK-2026-ABC123')
      .set('X-Forwarded-For', ip);
    expect(over.status).toBe(429);
    expect(over.headers['x-ratelimit-limit']).toBe(String(PUBLIC_VERIFY_ANON_MAX_PER_MIN));
    expect(over.headers['retry-after']).toBeDefined();
  });

  it('still holds the line when the verification API flag is off', async () => {
    // Skipping the IP guard must not leave verify unlimited on the dark-API
    // path, where apiV1Router's own anon limiter is never reached.
    const app = buildDarkApiApp();
    const ip = nextIp();
    let saw429 = false;

    for (let i = 0; i < PUBLIC_VERIFY_ANON_MAX_PER_MIN + 1; i++) {
      const res = await supertest(app)
        .get('/api/v1/verify/ARK-2026-ABC123')
        .set('X-Forwarded-For', ip);
      if (res.status === 429) {
        saw429 = true;
        break;
      }
      expect(res.status).toBe(503);
    }

    expect(saw429, 'anonymous verify must stay rate-limited even when /api/v1 is dark').toBe(true);
  });

  it('leaves keyed verify traffic to the 1,000/min per-key limiter', async () => {
    const app = buildApp();
    const ip = nextIp();
    const statuses: number[] = [];

    for (let i = 0; i < PUBLIC_VERIFY_ANON_MAX_PER_MIN + 20; i++) {
      const res = await supertest(app)
        .get('/api/v1/verify/ARK-2026-ABC123')
        .set('X-Forwarded-For', ip)
        .set('Authorization', 'Bearer ak_live_testkey');
      statuses.push(res.status);
    }

    expect(statuses.filter((s) => s === 429).length).toBe(0);
  });
});

/**
 * Mount guard — the half of this fix that does NOT live in this module.
 *
 * `shouldSkipApiIpShadowGuard` exempts `/api/v1/verify` from the 60/min guard
 * unconditionally. The ONLY thing that puts a cap back on that traffic is a
 * single line in `index.ts`:
 *
 *     app.use('/api/v1/verify', publicVerifyAnonLimiter);
 *
 * Delete that line, or move it below `app.use('/api/v1', apiV1Router)`, and
 * anonymous verify silently loses its early limiter — and with
 * `ENABLE_VERIFICATION_API` off it loses rate limiting ENTIRELY, because
 * apiV1Router's `verificationApiGate()` 503s before its own `anonRateLimiter`
 * ever runs. Every supertest case above would still pass, because they build
 * their own app. So the wiring is pinned here, against the real source file —
 * same technique as `paymentTierRouter.mount-guard.test.ts`.
 */
describe('index.ts wiring (mount guard)', () => {
  const workerSrc = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const indexSource = readFileSync(resolve(workerSrc, 'index.ts'), 'utf8');

  const verifyMount = /app\.use\(\s*['"]\/api\/v1\/verify['"]\s*,\s*publicVerifyAnonLimiter\s*\)/;
  const v1RouterMount = /app\.use\(\s*['"]\/api\/v1['"]\s*,\s*apiV1Router\s*\)/;
  const guardMount = /app\.use\(\s*['"]\/api['"]\s*,\s*apiIpShadowGuard\s*,/;

  it('mounts publicVerifyAnonLimiter at /api/v1/verify', () => {
    expect(
      verifyMount.test(indexSource),
      'the verify carve-out in shouldSkipApiIpShadowGuard is only safe while ' +
        'index.ts mounts publicVerifyAnonLimiter at /api/v1/verify',
    ).toBe(true);
  });

  it('mounts it ahead of apiV1Router, so it runs before verificationApiGate()', () => {
    const verifyAt = indexSource.search(verifyMount);
    const v1At = indexSource.search(v1RouterMount);

    expect(verifyAt, 'publicVerifyAnonLimiter mount not found in index.ts').toBeGreaterThan(-1);
    expect(v1At, 'apiV1Router mount not found in index.ts').toBeGreaterThan(-1);
    expect(
      verifyAt,
      'publicVerifyAnonLimiter must be mounted BEFORE apiV1Router: the v1 router runs ' +
        'verificationApiGate() before its own anon limiter, so with ENABLE_VERIFICATION_API ' +
        'off a verify request 503s without ever being counted',
    ).toBeLessThan(v1At);
  });

  it('still mounts apiIpShadowGuard on the broad /api prefix', () => {
    expect(
      guardMount.test(indexSource),
      'the 60/min backstop for anonymous non-verify /api traffic must stay mounted',
    ).toBe(true);
  });
});
