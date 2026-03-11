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
  mockProcessWebhookRetries,
  mockLogger,
  mockCronSchedule,
  mockConfig,
} = vi.hoisted(() => {
  const mockProcessPendingAnchors = vi.fn().mockResolvedValue({ processed: 0, failed: 0 });
  const mockHandleStripeWebhook = vi.fn().mockResolvedValue(undefined);
  const mockVerifyWebhookSignature = vi.fn().mockReturnValue({ id: 'evt_test', type: 'test' });
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
    useMocks: true,
  };

  return {
    mockProcessPendingAnchors,
    mockHandleStripeWebhook,
    mockVerifyWebhookSignature,
    mockProcessWebhookRetries,
    mockLogger,
    mockCronSchedule,
    mockConfig,
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
}));

vi.mock('./webhooks/delivery.js', () => ({
  processWebhookRetries: mockProcessWebhookRetries,
}));

vi.mock('node-cron', () => ({
  default: { schedule: mockCronSchedule },
}));

vi.mock('dotenv/config', () => ({}));

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
      get: (name: string) => (headers || {})[name.toLowerCase()],
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
    it('returns healthy status with expected fields', async () => {
      const res = await request(app, 'GET', '/health');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'healthy',
        network: 'testnet',
      });
      expect(res.body.uptime).toBeDefined();
      expect(typeof res.body.uptime).toBe('number');
      expect(res.body.version).toBeDefined();
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

  describe('monthly reset cron', () => {
    it('logs monthly reset message', async () => {
      const monthlyCallback = cronCalls[2][1];

      await monthlyCallback();

      expect(mockLogger.info).toHaveBeenCalledWith('Resetting monthly anchor counts');
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
});
