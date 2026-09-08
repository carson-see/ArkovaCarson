/**
 * Cron `/jobs/*` rate-limit scoping (SCRUM-4475).
 *
 * These tests deliberately do NOT mock `../utils/rateLimit.js` — `cron.test.ts`
 * replaces the limiter with a pass-through, which is exactly why the bug below
 * was invisible for the life of the router. Here the REAL limiters run behind
 * the REAL `cronAuth`, mounted by the REAL `cronRouter`, so the thing under
 * test is the budget a Cloud Scheduler job actually gets.
 *
 * HISTORY — the outage these tests were written against. `cronJobsLimiter` was
 * `rateLimit({ windowMs: 60_000, maxRequests: 30, scope: 'cron-jobs',
 * keyGenerator: () => 'global' })`: ONE 30/min bucket shared by all 111 routes
 * on this router. Prod runs 66 Cloud Scheduler jobs, and every two-, five-,
 * ten-, fifteen- and thirty-minute job plus every hourly job fires inside the
 * same minute at :00, so
 * the 31st job of that burst onwards was refused with 429. Cloud Scheduler
 * records that as status 8 RESOURCE_EXHAUSTED and does not retry inside the
 * window, so those runs were silently skipped, not delayed. The nightly
 * `daily-anchor-flush` (`0 3 * * *` America/New_York -> 07:00Z, target
 * `/jobs/batch-anchors?force=true`) was refused on 2026-09-04T07:00:51Z and
 * 2026-09-05T07:00:41Z; it last succeeded 2026-09-03T07:00:49Z.
 *
 * The fix is two limiters with different jobs:
 *
 *   1. `cron-burst` — PRE-auth, per source IP, wide. It is the flood guard that
 *      still applies to an unauthenticated caller, and it is what stops anyone
 *      reaching the JWKS fetch / JWT verification in `verifyCronAuth` at will.
 *   2. `cron-jobs` — POST-auth, one bucket per registered job path, narrow. No
 *      single job legitimately fires more than once a minute (`lock-wait` at
 *      `* * * * *` is the fastest), so 10/min per job is ~10x headroom while
 *      still catching a runaway trigger on ONE job without taking the other 65
 *      down with it.
 *
 * Because the per-job limiter sits BEHIND `cronAuth`, an unauthenticated caller
 * can never mint a per-path bucket: it is refused at auth, having been counted
 * only against its own IP's burst bucket. The path is additionally normalised
 * against the router's registered route table, so bucket cardinality is bounded
 * by the number of real routes (+1 shared `__unknown__` bucket) rather than by
 * whatever an attacker puts in the URL.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { NextFunction, Request, Response } from 'express';

const { CRON_SECRET } = vi.hoisted(() => ({ CRON_SECRET: 'test-cron-secret-scrum-4475' }));

vi.mock('../config.js', () => ({
  config: {
    // Production, so the real auth path runs rather than the dev bypass.
    nodeEnv: 'production',
    cronSecret: CRON_SECRET,
    cronOidcAudience: 'https://arkova-worker.run.app',
    frontendUrl: 'http://localhost:5173',
    corsAllowedOrigins: '',
    stripeSecretKey: 'sk_test_smoke',
    bitcoinNetwork: 'testnet',
    enableProdNetworkAnchoring: false,
    enableProfessionalEducationSchemaReady: true,
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Every job handler that gets this far fails fast on the stub and returns 500.
// That is fine: these tests assert on 429-vs-not, never on job output.
vi.mock('../utils/db.js', () => ({ db: { from: vi.fn(), rpc: vi.fn() } }));

vi.mock('./middleware.js', () => ({
  corsMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import { cronRouter } from './cron.js';
import {
  setRateLimitStore,
  getRateLimitStoreSize,
  stopRateLimitCleanup,
} from '../utils/rateLimit.js';

// §1.7: no real Stripe / Bitcoin / HTTP from a test. Any handler that reaches
// the network fails immediately and loudly instead of leaving the process.
const fetchStub = vi.fn().mockRejectedValue(new Error('network disabled in tests'));
vi.stubGlobal('fetch', fetchStub);

afterAll(() => {
  stopRateLimitCleanup();
  vi.unstubAllGlobals();
});

function makeApp() {
  const app = express();
  app.set('trust proxy', true); // X-Forwarded-For -> req.ip, so each test owns a burst bucket
  app.use(express.json());
  app.use('/jobs', cronRouter);
  return app;
}

/**
 * 40 job paths that really are registered on `cronRouter`, standing in for the
 * top-of-hour Cloud Scheduler burst. The first 13 are the jobs Cloud Logging
 * actually recorded 429s for between 2026-09-03T18Z and 2026-09-05T18Z
 * (`/batch-anchors` is `daily-anchor-flush`'s target); the rest fill the burst
 * out past the old 30/min global cap.
 */
const BURST_JOB_PATHS = [
  '/batch-anchors',
  '/org-queue-scheduler',
  '/lock-wait',
  '/embed-public-records',
  '/fetch-dapip',
  '/refresh-treasury-cache',
  '/process-revocations',
  '/rule-action-dispatcher',
  '/webhook-retries',
  '/drive-subscription-renewal',
  '/anchor-expiry-sweep',
  '/fetch-australia',
  '/fetch-cnpj-br',
  '/process-anchors',
  '/check-confirmations',
  '/populate-confirmation-proofs',
  '/classify-proof-backcatalog',
  '/materialize-proof-backcatalog',
  '/proof-coverage-monitor',
  '/queue-digest',
  '/platform-health-digest',
  '/credit-expiry',
  '/generate-reports',
  '/reconcile-credit-conservation',
  '/treasury-alert-check',
  '/ce-key-expiry-check',
  '/ce-registry-drift-check',
  '/queue-reminders',
  '/drain-connector-artifacts',
  '/rules-engine',
  '/docusign-envelope-completed',
  '/drive-file-changed',
  '/docusign-notarization-completed',
  '/ai-credit-reconcile',
  '/workspace-subscription-renewal',
  '/anchor-public-records',
  '/grace-expiry-sweep',
  '/nonce-sweep',
  '/cleanup-retention',
  '/db-health',
] as const;

/** Route paths `cronRouter` actually serves — the allowlist the key normaliser uses. */
function registeredRoutePaths(): Set<string> {
  const stack = (cronRouter as unknown as { stack: Array<{ route?: { path?: unknown } }> }).stack;
  const paths = new Set<string>();
  for (const layer of stack) {
    if (typeof layer.route?.path === 'string') paths.add(layer.route.path);
  }
  return paths;
}

beforeEach(() => {
  // Each test gets a virgin bucket store; the module-level Map is shared otherwise.
  setRateLimitStore(new Map());
  fetchStub.mockClear();
});

describe('cron /jobs/* rate limiting (SCRUM-4475)', () => {
  it('the 40 burst job paths are all real routes on cronRouter', () => {
    const registered = registeredRoutePaths();
    const missing = BURST_JOB_PATHS.filter((p) => !registered.has(p));
    expect(missing).toEqual([]);
  });

  it('refuses zero of a 40-distinct-job top-of-hour burst inside one minute', async () => {
    const app = makeApp();
    const statuses: Array<{ path: string; status: number }> = [];

    for (const path of BURST_JOB_PATHS) {
      const res = await request(app)
        .post(`/jobs${path}`)
        .set('X-Forwarded-For', '10.0.0.1')
        .set('X-Cron-Secret', CRON_SECRET);
      statuses.push({ path, status: res.status });
    }

    const refused = statuses.filter((s) => s.status === 429);
    expect(refused).toEqual([]);
    // Auth ran and passed for every one of them — nothing was rejected as 401.
    expect(statuses.filter((s) => s.status === 401)).toEqual([]);
  }, 60_000);

  it('daily-anchor-flush is admitted even when the whole burst precedes it', async () => {
    const app = makeApp();

    for (const path of BURST_JOB_PATHS.filter((p) => p !== '/batch-anchors')) {
      await request(app)
        .post(`/jobs${path}`)
        .set('X-Forwarded-For', '10.0.0.2')
        .set('X-Cron-Secret', CRON_SECRET);
    }

    // `daily-anchor-flush` -> POST /jobs/batch-anchors?force=true
    const res = await request(app)
      .post('/jobs/batch-anchors?force=true')
      .set('X-Forwarded-For', '10.0.0.2')
      .set('X-Cron-Secret', CRON_SECRET);

    expect(res.status).not.toBe(429);
  }, 60_000);

  it('refuses the 11th hit on ONE job path inside a minute with Retry-After', async () => {
    const app = makeApp();

    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post('/jobs/lock-wait')
        .set('X-Forwarded-For', '10.0.0.3')
        .set('X-Cron-Secret', CRON_SECRET);
      expect(res.status).not.toBe(429);
    }

    const refused = await request(app)
      .post('/jobs/lock-wait')
      .set('X-Forwarded-For', '10.0.0.3')
      .set('X-Cron-Secret', CRON_SECRET);

    expect(refused.status).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(refused.headers['x-ratelimit-limit']).toBe('10');
    expect(refused.body).toMatchObject({ error: 'Too many requests' });
  }, 60_000);

  it('one runaway job does not refuse a different job in the same window', async () => {
    const app = makeApp();

    for (let i = 0; i < 15; i++) {
      await request(app)
        .post('/jobs/lock-wait')
        .set('X-Forwarded-For', '10.0.0.4')
        .set('X-Cron-Secret', CRON_SECRET);
    }

    const other = await request(app)
      .post('/jobs/batch-anchors')
      .set('X-Forwarded-For', '10.0.0.4')
      .set('X-Cron-Secret', CRON_SECRET);

    expect(other.status).not.toBe(429);
  }, 60_000);

  it('an unauthenticated caller is refused at auth, never reaching a per-path bucket', async () => {
    const app = makeApp();

    for (const path of BURST_JOB_PATHS.slice(0, 20)) {
      const res = await request(app)
        .post(`/jobs${path}`)
        .set('X-Forwarded-For', '10.0.0.5');
      expect(res.status).toBe(401);
    }

    // 20 distinct paths, but only the caller's ONE per-IP burst bucket exists —
    // an anonymous caller cannot mint a bucket per route by enumerating URLs.
    expect(getRateLimitStoreSize()).toBe(1);
  }, 60_000);

  it('still rate-limits an unauthenticated flood (the limiter applies pre-auth)', async () => {
    const app = makeApp();
    const agent = request(app);
    let refused = 0;

    for (let i = 0; i < 130; i++) {
      const res = await agent
        .post('/jobs/batch-anchors')
        .set('X-Forwarded-For', '10.0.0.6');
      if (res.status === 429) refused++;
    }

    expect(refused).toBeGreaterThan(0);
  }, 60_000);

  it('bucket cardinality is bounded by real routes, not by attacker-chosen paths', async () => {
    const app = makeApp();

    for (let i = 0; i < 50; i++) {
      await request(app)
        .post(`/jobs/not-a-real-job-${i}`)
        .set('X-Forwarded-For', '10.0.0.7')
        .set('X-Cron-Secret', CRON_SECRET);
    }

    // One burst bucket + at most one shared bucket for unrouted paths.
    expect(getRateLimitStoreSize()).toBeLessThanOrEqual(2);
  }, 60_000);
});
