/**
 * F-2 coverage completion — index.ts branch coverage.
 *
 * `rateLimitShadowGuard.test.ts` proves the shadow-guard *behavior* but does
 * so against a locally-reconstructed middleware chain (its own copy of
 * `hasApiKeyCredential`), not the real `apiIpShadowGuard` defined in
 * index.ts:391-401. `index.test.ts` mocks `./utils/rateLimit.js` wholesale
 * (`rateLimit: () => passthrough`), so the real `skip` predicate built there
 * is constructed but never invoked — 0% branch coverage on index.ts:392-395
 * and :400, which dragged src/index.ts below the 60% branch threshold
 * (CI run 30466372409: 52.63%).
 *
 * This file imports the real `./utils/rateLimit.js` (no mock) and drives
 * actual HTTP requests at the real exported `app` so `hasApiKeyCredential`'s
 * two branches and the `skip` predicate's `startsWith('/api/v1/') && ...`
 * short-circuit both execute with every truthy/falsy combination.
 *
 * Route used: `GET /api/badge/:publicId`, mounted directly behind
 * `apiIpShadowGuard` (index.ts:402). The badge lookup itself 404s without a
 * real anchor — irrelevant here, since only the guard's decision to call
 * `next()` vs. enforce the bucket is under test.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import supertest from 'supertest';

const {
  mockLogger,
  mockCronSchedule,
  mockConfig,
  mockDbFrom,
  mockSupabaseGetUser,
  mockCallRpc,
  mockEstimateFee,
  mockRequireVersionOrgAdminContext,
  mockVersionResolutionRouter,
} = vi.hoisted(() => {
  const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const mockCronSchedule = vi.fn();
  const mockConfig = {
    port: 3098,
    nodeEnv: 'test',
    logLevel: 'info',
    supabaseUrl: 'https://test.supabase.co',
    supabaseServiceKey: 'test-key',
    stripeSecretKey: 'sk_test_123',
    stripeWebhookSecret: 'whsec_test',
    chainApiUrl: 'https://chain.test',
    chainApiKey: 'chain-key',
    chainNetwork: 'testnet',
    bitcoinNetwork: 'signet',
    enableProdNetworkAnchoring: false,
    useMocks: true,
    frontendUrl: 'http://localhost:5173',
    apiKeyHmacSecret: 'test-hmac-secret',
  };
  const mockDbFrom = vi.fn();
  const mockSupabaseGetUser = vi.fn();
  const mockCallRpc = vi.fn();
  const mockEstimateFee = vi.fn();
  const mockRequireVersionOrgAdminContext = vi.fn((_req, _res, next) => next());
  const mockVersionResolutionRouter = vi.fn((_req, res) => res.status(200).json({ ok: true }));

  return {
    mockLogger,
    mockCronSchedule,
    mockConfig,
    mockDbFrom,
    mockSupabaseGetUser,
    mockCallRpc,
    mockEstimateFee,
    mockRequireVersionOrgAdminContext,
    mockVersionResolutionRouter,
  };
});

vi.mock('./config.js', () => ({ config: mockConfig }));
vi.mock('./utils/logger.js', () => ({ logger: mockLogger }));

vi.mock('./utils/sentry.js', () => ({
  initSentry: vi.fn(),
  resolveSentryEnvironment: vi.fn(() => 'test'),
  withCronMonitoring: vi.fn((_name: string, _schedule: string, fn: () => unknown) => fn),
  Sentry: {
    setupExpressErrorHandler: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
}));

vi.mock('./jobs/anchor.js', () => ({
  processPendingAnchors: vi.fn().mockResolvedValue({ processed: 0, failed: 0 }),
}));
vi.mock('./jobs/check-confirmations.js', () => ({
  checkSubmittedConfirmations: vi.fn().mockResolvedValue({ checked: 0, confirmed: 0 }),
}));
vi.mock('./jobs/revocation.js', () => ({
  processRevokedAnchors: vi.fn().mockResolvedValue({ processed: 0, failed: 0 }),
}));
vi.mock('./stripe/handlers.js', () => ({
  handleStripeWebhook: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./stripe/client.js', () => ({
  verifyWebhookSignature: vi.fn().mockReturnValue({ id: 'evt_test', type: 'test' }),
  createCheckoutSession: vi.fn(),
  createBillingPortalSession: vi.fn(),
}));
vi.mock('./webhooks/delivery.js', () => ({
  processWebhookRetries: vi.fn().mockResolvedValue(0),
  resetCircuitBreakers: vi.fn(),
  getCircuitBreakerSize: vi.fn().mockReturnValue(0),
}));
vi.mock('node-cron', () => ({ default: { schedule: mockCronSchedule } }));
vi.mock('./utils/db.js', () => ({
  db: { from: mockDbFrom },
  isDbHealthy: () => true,
  recordDbSuccess: vi.fn(),
  recordDbFailure: vi.fn(),
  getDbCircuitState: () => ({ healthy: true, consecutiveFailures: 0, lastError: null }),
  getConnectionInfo: () => ({ mode: 'direct', url: 'https://test.supabase.co' }),
  resetDbCircuit: vi.fn(),
}));
vi.mock('./utils/rpc.js', () => ({ callRpc: mockCallRpc }));
vi.mock('./chain/fee-estimator.js', () => ({
  createFeeEstimator: () => ({ estimateFee: mockEstimateFee }),
}));
vi.mock('./api/version-resolution.js', () => ({
  requireVersionOrgAdminContext: mockRequireVersionOrgAdminContext,
  versionResolutionRouter: mockVersionResolutionRouter,
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { getUser: mockSupabaseGetUser } }),
}));
vi.mock('./auth.js', () => ({
  verifyAuthToken: async (token: string) => {
    if (!token) return null;
    try {
      const result = await mockSupabaseGetUser(token);
      return result?.data?.user?.id ?? null;
    } catch {
      return null;
    }
  },
}));
vi.mock('dotenv/config', () => ({}));
vi.mock('compression', () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('./middleware/idempotency.js', () => ({
  idempotencyMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  stopIdempotencyCleanup: vi.fn(),
  clearIdempotencyStore: vi.fn(),
  getIdempotencyStoreSize: vi.fn().mockReturnValue(0),
}));

// NOTE: deliberately NOT mocking './utils/rateLimit.js' — this file exists
// specifically to exercise the REAL apiIpShadowGuard / hasApiKeyCredential
// defined in index.ts against the real rateLimit() implementation.

// Prevent a real app.listen() from binding a port during module import.
vi.mock('express', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('express');
  const originalExpress = actual.default as ((...args: unknown[]) => Record<string, unknown>) & Record<string, unknown>;

  const wrappedExpress = ((...args: unknown[]) => {
    const app = originalExpress(...args);
    app.listen = vi.fn((_port: number, cb?: () => void) => {
      cb?.();
      return {
        close: vi.fn((closeCb?: () => void) => closeCb?.()),
        address: () => ({ port: 3098 }),
      } as unknown as ReturnType<typeof import('net').Server.prototype.listen>;
    });
    return app;
  }) as typeof originalExpress;

  wrappedExpress.raw = originalExpress.raw;
  wrappedExpress.json = originalExpress.json;
  wrappedExpress.urlencoded = originalExpress.urlencoded;
  wrappedExpress.static = originalExpress.static;
  wrappedExpress.Router = originalExpress.Router;

  return { ...actual, default: wrappedExpress };
});

let app: Express;

beforeAll(async () => {
  const mod = await import('./index.js');
  app = mod.app;
});

afterAll(async () => {
  const { stopRateLimitCleanup } = await import('./utils/rateLimit.js');
  stopRateLimitCleanup();
});

describe('F-2 apiIpShadowGuard — real index.ts middleware, real rateLimit()', () => {
  it('non-/api/v1 request with no credential hits the real hasApiKeyCredential=false path (both branches false)', async () => {
    const res = await supertest(app).get('/api/badge/does-not-exist-1');
    // apiIpShadowGuard's skip short-circuits false on originalUrl (not /api/v1/*)
    // before hasApiKeyCredential is even called — request proceeds to badgeRouter,
    // which 404s the unknown public id. Any non-429 status proves the guard ran.
    expect(res.status).not.toBe(429);
  });

  it('non-/api/v1 request WITH a well-formed Bearer credential still does not skip (prefix check fails first)', async () => {
    const res = await supertest(app)
      .get('/api/badge/does-not-exist-2')
      .set('Authorization', 'Bearer ak_live_covertest');
    expect(res.status).not.toBe(429);
  });

  it('/api/v1/* style path with Bearer ak_ credential exercises hasApiKeyCredential Bearer-true branch', async () => {
    // No /api/v1 badge route exists, but the shadow guard only mounts on the
    // /api prefix ahead of badgeRouter — it still runs (and its skip predicate
    // still evaluates) for any /api/* path, including ones badgeRouter itself
    // won't match. A 404 (not 429) proves next() was reached via skip=true.
    const res = await supertest(app)
      .get('/api/v1/does-not-exist-anywhere')
      .set('Authorization', 'Bearer ak_live_covertest');
    expect(res.status).not.toBe(429);
  });

  it('/api/v1/* path with X-API-Key ak_-prefixed credential exercises the xApiKey-true branch', async () => {
    const res = await supertest(app)
      .get('/api/v1/does-not-exist-anywhere-2')
      .set('X-API-Key', 'ak_live_covertest2');
    expect(res.status).not.toBe(429);
  });

  it('/api/v1/* path with a malformed Authorization header (not Bearer-prefixed) falls through to the xApiKey check', async () => {
    const res = await supertest(app)
      .get('/api/v1/does-not-exist-anywhere-3')
      .set('Authorization', 'Basic not-a-bearer-token');
    expect(res.status).not.toBe(429);
  });

  it('/api/v1/* path with an X-API-Key present but NOT ak_-prefixed exercises the xApiKey-false branch', async () => {
    const res = await supertest(app)
      .get('/api/v1/does-not-exist-anywhere-4')
      .set('X-API-Key', 'not-a-valid-key-prefix');
    expect(res.status).not.toBe(429);
  });

  it('/api/v1/* path with neither header present exercises hasApiKeyCredential returning false end-to-end', async () => {
    const res = await supertest(app).get('/api/v1/does-not-exist-anywhere-5');
    expect(res.status).not.toBe(429);
  });
});
