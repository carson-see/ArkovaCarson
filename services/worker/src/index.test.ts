/**
 * Unit tests for worker Express server
 *
 * HARDENING-5: Health endpoint, Stripe webhook route, anchor processing
 * route, cron job setup, graceful shutdown.
 *
 * NOTE: index.ts runs module-level side effects (app.listen, setupScheduledJobs,
 * setupGracefulShutdown). These run once at import time — cron.schedule calls
 * are captured during the first import and tested separately from route tests.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';

// ---- Hoisted mocks ----

const {
  mockProcessPendingAnchors,
  mockHandleStripeWebhook,
  mockVerifyWebhookSignature,
  mockCreateCheckoutSession,
  mockCreateBillingPortalSession,
  mockProcessWebhookRetries,
  mockLogger,
  mockCronSchedule,
  mockConfig,
  mockDbFrom,
  mockSupabaseGetUser,
} = vi.hoisted(() => {
  const mockProcessPendingAnchors = vi.fn().mockResolvedValue({ processed: 0, failed: 0 });
  const mockHandleStripeWebhook = vi.fn().mockResolvedValue(undefined);
  const mockVerifyWebhookSignature = vi.fn().mockReturnValue({ id: 'evt_test', type: 'test' });
  const mockCreateCheckoutSession = vi.fn();
  const mockCreateBillingPortalSession = vi.fn();
  const mockProcessWebhookRetries = vi.fn().mockResolvedValue(0);
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mockCronSchedule = vi.fn();
  const mockConfig = {
    port: 3099,
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
  };
  const mockDbFrom = vi.fn();
  const mockSupabaseGetUser = vi.fn();

  return {
    mockProcessPendingAnchors,
    mockHandleStripeWebhook,
    mockVerifyWebhookSignature,
    mockCreateCheckoutSession,
    mockCreateBillingPortalSession,
    mockProcessWebhookRetries,
    mockLogger,
    mockCronSchedule,
    mockConfig,
    mockDbFrom,
    mockSupabaseGetUser,
  };
});

vi.mock('./config.js', () => ({
  config: mockConfig,
}));

vi.mock('./utils/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('./jobs/anchor.js', () => ({
  processPendingAnchors: mockProcessPendingAnchors,
}));

vi.mock('./stripe/handlers.js', () => ({
  handleStripeWebhook: mockHandleStripeWebhook,
}));

vi.mock('./stripe/client.js', () => ({
  verifyWebhookSignature: mockVerifyWebhookSignature,
  createCheckoutSession: mockCreateCheckoutSession,
  createBillingPortalSession: mockCreateBillingPortalSession,
}));

vi.mock('./webhooks/delivery.js', () => ({
  processWebhookRetries: mockProcessWebhookRetries,
}));

vi.mock('node-cron', () => ({
  default: { schedule: mockCronSchedule },
}));

vi.mock('./utils/db.js', () => ({
  db: { from: mockDbFrom },
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: mockSupabaseGetUser },
  }),
}));

// Mock auth.ts — delegates to mockSupabaseGetUser for test controllability
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

// Bypass rate limiters in tests so requests aren't 429'd
vi.mock('./utils/rateLimit.js', () => {
  const passthrough = (_req: any, _res: any, next: any) => next();
  return {
    rateLimiters: {
      stripeWebhook: passthrough,
      checkout: passthrough,
    },
  };
});

// Preserve express static methods (raw, json, etc.) while overriding listen
vi.mock('express', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual: any = await vi.importActual('express');
  const originalExpress: any = actual.default;

  const wrappedExpress: any = (...args: any[]) => {
    const app = originalExpress(...args);
    app.listen = vi.fn((_port: number, cb?: () => void) => {
      cb?.();
      return {
        close: vi.fn((closeCb?: () => void) => closeCb?.()),
        address: () => ({ port: 3099 }),
      } as any;
    });
    return app;
  };

  // Copy static methods from original express
  wrappedExpress.raw = originalExpress.raw;
  wrappedExpress.json = originalExpress.json;
  wrappedExpress.urlencoded = originalExpress.urlencoded;
  wrappedExpress.static = originalExpress.static;
  wrappedExpress.Router = originalExpress.Router;

  return { ...actual, default: wrappedExpress };
});

// Helper to make HTTP-like requests to Express app
async function request(app: Express, method: string, path: string, body?: any, headers?: Record<string, string>) {
  return new Promise<{ status: number; body: any; headers: Record<string, string> }>((resolve) => {
    const responseHeaders: Record<string, string> = {};
    let responseBody: any;
    let responseStatus = 200;

    const req: any = {
      method: method.toUpperCase(),
      url: path,
      path,
      headers: { ...headers },
      body,
      ip: '127.0.0.1',
      get: (name: string) => headers?.[name.toLowerCase()],
    };

    const res: any = {
      statusCode: 200,
      status(code: number) {
        responseStatus = code;
        this.statusCode = code;
        return this;
      },
      json(data: any) {
        responseBody = data;
        resolve({ status: responseStatus, body: responseBody, headers: responseHeaders });
        return this;
      },
      send(data: any) {
        responseBody = data;
        resolve({ status: responseStatus, body: responseBody, headers: responseHeaders });
        return this;
      },
      setHeader(name: string, value: string) {
        responseHeaders[name] = value;
        return this;
      },
      end() {
        resolve({ status: responseStatus, body: responseBody, headers: responseHeaders });
      },
    };

    (app as any).handle(req, res, () => {
      responseStatus = 404;
      resolve({ status: 404, body: { error: 'Not Found' }, headers: responseHeaders });
    });
  });
}

/** Shared mock DB chain builder — avoids duplication across describe blocks */
function mockDbChain(result: { data: any; error: any }) {
  const chain: any = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result),
    single: vi.fn().mockResolvedValue(result),
    maybeSingle: vi.fn().mockResolvedValue(result),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.in.mockReturnValue(chain);
  return chain;
}

// Import module once — side effects (listen, cron, shutdown) run at import time
let app: Express;
let server: any;
let cronCalls: any[];

beforeAll(async () => {
  const mod = await import('./index.js');
  app = mod.app;
  server = mod.server;
  // Snapshot cron calls before any clearAllMocks wipes them
  cronCalls = [...mockCronSchedule.mock.calls];
});

describe('worker server', () => {
  beforeEach(() => {
    // Clear call counts for route handler mocks, but NOT cron (already captured)
    mockProcessPendingAnchors.mockClear();
    mockHandleStripeWebhook.mockClear();
    mockVerifyWebhookSignature.mockClear();
    mockProcessWebhookRetries.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
  });

  describe('GET /health', () => {
    it('returns healthy status when Supabase is reachable', async () => {
      mockDbFrom.mockReturnValue(mockDbChain({ data: [{ id: '1' }], error: null }));

      const res = await request(app, 'GET', '/health');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'healthy',
        network: 'signet',
        checks: { supabase: 'ok' },
      });
      expect(typeof res.body.uptime).toBe('number');
      expect(res.body.version).toBeDefined();
    });

    it('returns degraded status when Supabase is unreachable', async () => {
      mockDbFrom.mockReturnValue(mockDbChain({ data: null, error: { message: 'connection refused' } }));

      const res = await request(app, 'GET', '/health');

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        status: 'degraded',
        checks: { supabase: 'error' },
      });
    });
  });

  describe('POST /jobs/process-anchors', () => {
    it('calls processPendingAnchors and returns result', async () => {
      mockProcessPendingAnchors.mockResolvedValue({ processed: 3, failed: 1 });

      const res = await request(app, 'POST', '/jobs/process-anchors');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ processed: 3, failed: 1 });
      expect(mockProcessPendingAnchors).toHaveBeenCalledOnce();
    });

    it('returns 500 when processPendingAnchors throws', async () => {
      mockProcessPendingAnchors.mockRejectedValue(new Error('DB down'));

      const res = await request(app, 'POST', '/jobs/process-anchors');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Processing failed' });
    });
  });

  describe('cron job setup', () => {
    it('registers 3 cron jobs', () => {
      expect(cronCalls).toHaveLength(3);
    });

    it('registers anchor processing at every minute', () => {
      expect(cronCalls[0][0]).toBe('* * * * *');
    });

    it('registers webhook retries at every 2 minutes', () => {
      expect(cronCalls[1][0]).toBe('*/2 * * * *');
    });

    it('registers monthly reset on 1st at midnight', () => {
      expect(cronCalls[2][0]).toBe('0 0 1 * *');
    });
  });

  describe('scheduled job error handling', () => {
    it('anchor processing cron catches and logs errors', async () => {
      const anchorCallback = cronCalls[0][1];
      mockProcessPendingAnchors.mockRejectedValue(new Error('cron fail'));

      await anchorCallback();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        'Scheduled anchor processing failed'
      );
    });

    it('webhook retry cron catches and logs errors', async () => {
      const webhookCallback = cronCalls[1][1];
      mockProcessWebhookRetries.mockRejectedValue(new Error('retry fail'));

      await webhookCallback();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        'Scheduled webhook retry processing failed'
      );
    });

    it('webhook retry cron logs count when retries processed', async () => {
      const webhookCallback = cronCalls[1][1];
      mockProcessWebhookRetries.mockResolvedValue(5);

      await webhookCallback();

      expect(mockLogger.info).toHaveBeenCalledWith(
        { retried: 5 },
        'Processed webhook retries'
      );
    });
  });

  describe('POST /webhooks/stripe', () => {
    it('returns 400 when stripe-signature header missing and not in mock mode', async () => {
      const original = mockConfig.useMocks;
      mockConfig.useMocks = false;

      const res = await request(app, 'POST', '/webhooks/stripe', '{}', {});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Missing stripe-signature header' });

      mockConfig.useMocks = original;
    });

    it('calls handleStripeWebhook on valid webhook', async () => {
      mockVerifyWebhookSignature.mockReturnValue({ id: 'evt_1', type: 'checkout.session.completed' });
      mockHandleStripeWebhook.mockResolvedValue(undefined);

      const res = await request(app, 'POST', '/webhooks/stripe', '{}', {
        'stripe-signature': 'sig_test',
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
      expect(mockHandleStripeWebhook).toHaveBeenCalledWith({ id: 'evt_1', type: 'checkout.session.completed' });
    });

    it('returns 400 when webhook processing throws', async () => {
      mockVerifyWebhookSignature.mockImplementation(() => {
        throw new Error('Invalid signature');
      });

      const res = await request(app, 'POST', '/webhooks/stripe', '{}', {
        'stripe-signature': 'bad_sig',
      });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Webhook processing failed' });
    });
  });

  describe('monthly credit allocation cron', () => {
    it('logs monthly credit allocation message', async () => {
      const monthlyCallback = cronCalls[2][1];

      await monthlyCallback();

      expect(mockLogger.info).toHaveBeenCalledWith('Running monthly credit allocation');
    });
  });

  describe('graceful shutdown', () => {
    it('handles SIGTERM by logging and closing server', () => {
      const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      process.emit('SIGTERM');

      expect(mockLogger.info).toHaveBeenCalledWith(
        { signal: 'SIGTERM' },
        'Received shutdown signal'
      );
      expect(mockLogger.info).toHaveBeenCalledWith('HTTP server closed');
      expect(mockExit).toHaveBeenCalledWith(0);

      mockExit.mockRestore();
    });

    it('forces exit after 30 second timeout', () => {
      vi.useFakeTimers();
      const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      process.emit('SIGINT');

      // Immediate exit(0) called
      expect(mockExit).toHaveBeenCalledWith(0);
      mockExit.mockClear();

      // Advance past 30-second forced shutdown timeout
      vi.advanceTimersByTime(30000);

      expect(mockLogger.warn).toHaveBeenCalledWith('Forcing shutdown after timeout');
      expect(mockExit).toHaveBeenCalledWith(1);

      mockExit.mockRestore();
      vi.useRealTimers();
    });
  });

  describe('server exports', () => {
    it('exports app and server', () => {
      expect(app).toBeDefined();
      expect(server).toBeDefined();
    });
  });

  // ================================================================
  // CORS preflight
  // ================================================================

  describe('OPTIONS /api/checkout/session (CORS preflight)', () => {
    it('returns 204 with CORS headers for allowed origin', async () => {
      const res = await request(app, 'OPTIONS', '/api/checkout/session', undefined, {
        origin: 'http://localhost:5173',
      });

      expect(res.status).toBe(204);
      expect(res.headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
      expect(res.headers['Access-Control-Allow-Methods']).toBe('POST, OPTIONS');
      expect(res.headers['Access-Control-Allow-Headers']).toBe('Content-Type, Authorization');
    });

    it('does not set CORS headers for disallowed origin', async () => {
      const res = await request(app, 'OPTIONS', '/api/checkout/session', undefined, {
        origin: 'https://evil.example.com',
      });

      expect(res.status).toBe(204);
      expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
    });
  });

  describe('OPTIONS /api/billing/portal (CORS preflight)', () => {
    it('returns 204 with CORS headers for allowed origin', async () => {
      const res = await request(app, 'OPTIONS', '/api/billing/portal', undefined, {
        origin: 'http://localhost:5173',
      });

      expect(res.status).toBe(204);
      expect(res.headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
    });
  });

  // ================================================================
  // POST /api/checkout/session
  // ================================================================

  describe('POST /api/checkout/session', () => {
    const validPlan = {
      id: 'plan-uuid-1',
      name: 'Pro',
      stripe_price_id: 'price_test_abc',
      price_cents: 2900,
      anchor_limit: 1000,
    };

    beforeEach(() => {
      mockDbFrom.mockClear();
      mockSupabaseGetUser.mockClear();
      mockCreateCheckoutSession.mockClear();
    });

    it('returns 401 without Authorization header', async () => {
      const res = await request(app, 'POST', '/api/checkout/session', { planId: 'plan-1' });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Authentication required' });
    });

    it('returns 401 with invalid Bearer token', async () => {
      mockSupabaseGetUser.mockResolvedValue({ data: { user: null }, error: new Error('Invalid') });

      const res = await request(app, 'POST', '/api/checkout/session', { planId: 'plan-1' }, {
        authorization: 'Bearer bad-token',
      });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Authentication required' });
    });

    it('returns 400 when planId is missing', async () => {
      mockSupabaseGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });

      const res = await request(app, 'POST', '/api/checkout/session', {}, {
        authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'planId is required' });
    });

    it('returns 404 when plan not found', async () => {
      mockSupabaseGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });

      const planChain = mockDbChain({ data: null, error: { message: 'Not found' } });
      mockDbFrom.mockReturnValue(planChain);

      const res = await request(app, 'POST', '/api/checkout/session', { planId: 'bad-plan' }, {
        authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Plan not found' });
    });

    it('returns 400 when plan has no stripe_price_id', async () => {
      mockSupabaseGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });

      const planChain = mockDbChain({ data: { ...validPlan, stripe_price_id: null }, error: null });
      mockDbFrom.mockReturnValue(planChain);

      const res = await request(app, 'POST', '/api/checkout/session', { planId: validPlan.id }, {
        authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Plan is not available for online checkout' });
    });

    it('returns 404 when profile not found', async () => {
      mockSupabaseGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });

      let callCount = 0;
      mockDbFrom.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // plans query
          return mockDbChain({ data: validPlan, error: null });
        }
        // profiles query
        return mockDbChain({ data: null, error: { message: 'Not found' } });
      });

      const res = await request(app, 'POST', '/api/checkout/session', { planId: validPlan.id }, {
        authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'User profile not found' });
    });

    it('returns 409 when user has active subscription', async () => {
      mockSupabaseGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });

      let callCount = 0;
      mockDbFrom.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return mockDbChain({ data: validPlan, error: null });
        if (callCount === 2) return mockDbChain({ data: { email: 'user@test.com' }, error: null });
        // subscriptions check — active sub exists
        return mockDbChain({ data: { id: 'sub-1', status: 'active' }, error: null });
      });

      const res = await request(app, 'POST', '/api/checkout/session', { planId: validPlan.id }, {
        authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('already has an active subscription');
    });

    it('creates checkout session and returns URL on success', async () => {
      mockSupabaseGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });

      let callCount = 0;
      mockDbFrom.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return mockDbChain({ data: validPlan, error: null });
        if (callCount === 2) return mockDbChain({ data: { email: 'user@test.com' }, error: null });
        // subscriptions check — no active sub
        return mockDbChain({ data: null, error: null });
      });

      mockCreateCheckoutSession.mockResolvedValue({
        sessionId: 'cs_test_123',
        url: 'https://checkout.stripe.com/cs_test_123',
      });

      const res = await request(app, 'POST', '/api/checkout/session', { planId: validPlan.id }, {
        authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sessionId: 'cs_test_123',
        url: 'https://checkout.stripe.com/cs_test_123',
      });
      expect(mockCreateCheckoutSession).toHaveBeenCalledOnce();
    });

    it('returns 500 when createCheckoutSession throws', async () => {
      mockSupabaseGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });

      let callCount = 0;
      mockDbFrom.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return mockDbChain({ data: validPlan, error: null });
        if (callCount === 2) return mockDbChain({ data: { email: 'user@test.com' }, error: null });
        return mockDbChain({ data: null, error: null });
      });

      mockCreateCheckoutSession.mockRejectedValue(new Error('Stripe boom'));

      const res = await request(app, 'POST', '/api/checkout/session', { planId: validPlan.id }, {
        authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to create checkout session' });
    });

    it('sets CORS headers when origin is allowed', async () => {
      mockSupabaseGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });

      const res = await request(app, 'POST', '/api/checkout/session', {}, {
        authorization: 'Bearer valid-token',
        origin: 'http://localhost:5173',
      });

      expect(res.headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
    });
  });

  // ================================================================
  // POST /api/billing/portal
  // ================================================================

  describe('POST /api/billing/portal', () => {
    beforeEach(() => {
      mockDbFrom.mockClear();
      mockSupabaseGetUser.mockClear();
      mockCreateBillingPortalSession.mockClear();
    });

    it('returns 401 without auth', async () => {
      const res = await request(app, 'POST', '/api/billing/portal', {});

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Authentication required' });
    });

    it('returns 404 when no subscription found', async () => {
      mockSupabaseGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
      mockDbFrom.mockReturnValue(mockDbChain({ data: null, error: { message: 'Not found' } }));

      const res = await request(app, 'POST', '/api/billing/portal', {}, {
        authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'No active subscription found' });
    });

    it('returns portal URL on success', async () => {
      mockSupabaseGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
      mockDbFrom.mockReturnValue(
        mockDbChain({ data: { stripe_customer_id: 'cus_test_1' }, error: null })
      );
      mockCreateBillingPortalSession.mockResolvedValue({
        url: 'https://billing.stripe.com/session/bps_test',
      });

      const res = await request(app, 'POST', '/api/billing/portal', {}, {
        authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ url: 'https://billing.stripe.com/session/bps_test' });
      expect(mockCreateBillingPortalSession).toHaveBeenCalledOnce();
    });

    it('returns 500 when createBillingPortalSession throws', async () => {
      mockSupabaseGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
      mockDbFrom.mockReturnValue(
        mockDbChain({ data: { stripe_customer_id: 'cus_test_1' }, error: null })
      );
      mockCreateBillingPortalSession.mockRejectedValue(new Error('Portal boom'));

      const res = await request(app, 'POST', '/api/billing/portal', {}, {
        authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to create billing portal session' });
    });
  });

  // ================================================================
  // POST /api/verify-anchor
  // ================================================================

  describe('POST /api/verify-anchor', () => {
    beforeEach(() => {
      mockDbFrom.mockClear();
    });

    it('returns 400 when fingerprint is missing', async () => {
      const res = await request(app, 'POST', '/api/verify-anchor', {});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'fingerprint is required (64-char hex SHA-256)' });
    });

    it('returns verification result for valid fingerprint', async () => {
      const chain: any = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            fingerprint: 'a'.repeat(64),
            status: 'SECURED',
            chain_tx_id: 'tx_123',
            chain_block_height: 100,
            chain_timestamp: '2026-03-14T00:00:00Z',
            public_id: 'pub-1',
            created_at: '2026-03-14T00:00:00Z',
            credential_type: 'diploma',
          },
          error: null,
        }),
      };
      mockDbFrom.mockReturnValue(chain);

      const res = await request(app, 'POST', '/api/verify-anchor', { fingerprint: 'a'.repeat(64) }, {
        origin: 'http://localhost:5173',
      });

      expect(res.status).toBe(200);
      expect(res.body.verified).toBe(true);
    });

    it('returns 500 when verification throws', async () => {
      mockDbFrom.mockImplementation(() => { throw new Error('DB down'); });

      const res = await request(app, 'POST', '/api/verify-anchor', { fingerprint: 'a'.repeat(64) });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Verification failed' });
    });
  });

  describe('OPTIONS /api/verify-anchor (CORS preflight)', () => {
    it('returns 204 with CORS headers', async () => {
      const res = await request(app, 'OPTIONS', '/api/verify-anchor', undefined, {
        origin: 'http://localhost:5173',
      });

      expect(res.status).toBe(204);
      expect(res.headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
    });
  });

  // ================================================================
  // extractAuthUserId edge cases
  // ================================================================

  describe('auth extraction edge cases', () => {
    beforeEach(() => {
      mockSupabaseGetUser.mockClear();
      mockDbFrom.mockClear();
    });

    it('returns 401 for Bearer with empty token', async () => {
      const res = await request(app, 'POST', '/api/checkout/session', { planId: 'p1' }, {
        authorization: 'Bearer ',
      });

      expect(res.status).toBe(401);
    });

    it('returns 401 for non-Bearer auth header', async () => {
      const res = await request(app, 'POST', '/api/checkout/session', { planId: 'p1' }, {
        authorization: 'Basic dXNlcjpwYXNz',
      });

      expect(res.status).toBe(401);
    });

    it('returns 401 when getUser throws', async () => {
      mockSupabaseGetUser.mockRejectedValue(new Error('Network error'));

      const res = await request(app, 'POST', '/api/checkout/session', { planId: 'p1' }, {
        authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(401);
    });
  });
});
