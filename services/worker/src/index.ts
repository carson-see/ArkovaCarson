/**
 * Arkova Anchoring Worker
 *
 * Dedicated Node.js service for backend processing.
 * Per Constitution: Next.js API routes are forbidden.
 *
 * ARCH-1 refactor: This file is now a slim compositor (~100 lines).
 * Route handlers live in routes/*.ts, scheduled jobs in routes/scheduled.ts.
 */

// Load environment variables FIRST before any other imports
import 'dotenv/config';

import express from 'express';
import { config } from './config.js';
import { initSentry, Sentry } from './utils/sentry.js';
import { logger } from './utils/logger.js';
import { db, isDbHealthy, recordDbSuccess, recordDbFailure, getDbCircuitState } from './utils/db.js';
import { initChainClient } from './chain/client.js';
import { handleStripeWebhook } from './stripe/handlers.js';
import { verifyWebhookSignature } from './stripe/client.js';
import { rateLimiters } from './utils/rateLimit.js';
import { apiV1Router } from './api/v1/router.js';
import { docsRouter } from './api/v1/docs.js';

// Extracted routers (ARCH-1)
import { billingRouter } from './routes/billing.js';
import { anchorRouter } from './routes/anchor.js';
import { adminRouter } from './routes/admin.js';
import { cronRouter } from './routes/cron.js';
import { identityRouter } from './api/v1/identity.js';
import { orgVerificationRouter } from './api/v1/orgVerification.js';
import { orgSubOrgsRouter } from './api/v1/orgSubOrgs.js';
import { corsMiddleware, requireAuth as requireAuthMw } from './routes/middleware.js';
import { globalErrorHandler } from './routes/errorHandler.js';
import { setupScheduledJobs } from './routes/scheduled.js';
import { setupGracefulShutdown, trackOperation } from './routes/lifecycle.js';
import { flagRegistry } from './middleware/flagRegistry.js';
import { correlationIdMiddleware } from './utils/correlationId.js';
import { initUpstashRateLimiting } from './utils/upstashRateLimit.js';

// Initialize Sentry BEFORE Express app — PII scrubbing mandatory (Constitution 1.4 + 1.6)
initSentry(config.sentryDsn, config.nodeEnv);

const app = express();

// Disable x-powered-by header to prevent Express version disclosure
app.disable('x-powered-by');

// AUTH-03: Trust proxy for correct client IP behind Cloud Run / Cloudflare Tunnel
if (config.nodeEnv === 'production') {
  app.set('trust proxy', 2);
}

// ─── X-Request-Id on every response (DX-6) ───
app.use(correlationIdMiddleware);

// ─── Health check — always available, no auth ───
app.get('/health', async (req, res) => {
  const detailed = req.query.detailed === 'true';
  const checks: Record<string, { status: 'ok' | 'error'; latencyMs?: number; message?: string }> = {};

  if (!isDbHealthy()) {
    const circuitState = getDbCircuitState();
    checks.supabase = {
      status: 'error',
      message: `Circuit breaker open (${circuitState.consecutiveFailures} consecutive failures): ${circuitState.lastError}`,
    };
  } else {
    const dbStart = Date.now();
    try {
      const { error } = await db.from('plans').select('id').limit(1);
      if (error) {
        recordDbFailure(error);
        checks.supabase = { status: 'error', latencyMs: Date.now() - dbStart, message: error.message };
      } else {
        recordDbSuccess();
        checks.supabase = { status: 'ok', latencyMs: Date.now() - dbStart };
      }
    } catch (err) {
      recordDbFailure(err);
      checks.supabase = {
        status: 'error',
        latencyMs: Date.now() - dbStart,
        message: err instanceof Error ? err.message : 'Connection failed',
      };
    }
  }

  const info: Record<string, { configured: boolean; message?: string }> = {};
  info.stripe = { configured: Boolean(config.stripeSecretKey) };
  info.sentry = {
    configured: Boolean(config.sentryDsn),
    ...(!config.sentryDsn ? { message: 'SENTRY_DSN not configured' } : {}),
  };
  info.ai = {
    configured: Boolean(config.geminiApiKey) || config.aiProvider === 'mock',
  };

  const allHealthy = Object.values(checks).every((c) => c.status === 'ok');

  const compactChecks: Record<string, 'ok' | 'error'> = {};
  for (const [key, val] of Object.entries(checks)) {
    compactChecks[key] = val.status;
  }

  if (!allHealthy) {
    res.setHeader('Retry-After', '60');
  }
  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'healthy' : 'degraded',
    version: process.env.npm_package_version ?? '0.1.0',
    uptime: Math.floor(process.uptime()),
    network: config.bitcoinNetwork,
    checks: detailed ? checks : compactChecks,
    ...(detailed ? { info } : {}),
  });
});

// ─── Stripe webhook — raw body required, before json parser ───
app.post(
  '/webhooks/stripe',
  rateLimiters.stripeWebhook,
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'] as string;
    if (!sig && !config.useMocks) {
      logger.warn('Missing stripe-signature header');
      res.status(400).json({ error: 'Missing stripe-signature header' });
      return;
    }
    try {
      const event = verifyWebhookSignature(req.body, sig ?? '');
      await handleStripeWebhook(event);
      res.json({ received: true });
    } catch (error) {
      logger.error({ error }, 'Webhook signature verification or processing failed');
      res.status(400).json({ error: 'Webhook processing failed' });
    }
  }
);

// JSON body parser for all other routes
app.use(express.json());

// ─── Mount routers (ARCH-1: each router owns its middleware) ───
app.use('/api', billingRouter);    // /api/checkout/session, /api/billing/portal
app.use('/api', anchorRouter);     // /api/verify-anchor, /api/recipients, /api/account
app.use('/api', adminRouter);      // /api/treasury/*, /api/admin/*
app.use('/jobs', cronRouter);      // /jobs/* (Cloud Scheduler + dev manual trigger)

// API docs — no auth, no feature flag (P4.5-TS-04)
app.use('/api/docs', docsRouter);
app.get('/.well-known/openapi.json', (_req, res) => {
  res.redirect(301, '/api/docs/spec.json');
});

// Identity & org verification — internal (frontend-facing), not behind feature gate
app.use('/api/v1/identity', corsMiddleware, rateLimiters.api, requireAuthMw, identityRouter);
app.use('/api/v1/org', corsMiddleware, rateLimiters.api, requireAuthMw, orgVerificationRouter);
app.use('/api/v1/org/sub-orgs', corsMiddleware, rateLimiters.api, requireAuthMw, orgSubOrgsRouter);

// Verification API v1 — gated behind ENABLE_VERIFICATION_API flag
app.use('/api/v1', apiV1Router);

// ─── Error handling (ARCH-4) ───
// Sentry error handler must be after all routes, before global error handler
Sentry.setupExpressErrorHandler(app);
app.use(globalErrorHandler);

// ─── Start server ───
const server = app.listen(config.port, async () => {
  logger.info(
    {
      port: config.port,
      env: config.nodeEnv,
      network: config.bitcoinNetwork,
      mocks: config.useMocks,
    },
    'Worker service started'
  );

  // IDEM-2: Initialize Redis-backed rate limiting if Upstash is configured
  initUpstashRateLimiting();

  // ARCH-5: Initialize feature flag registry — logs all active flags
  await flagRegistry.init();

  // Initialize chain client singleton
  let chainInitialized = false;
  try {
    await initChainClient();
    logger.info('Chain client initialized');
    chainInitialized = true;
  } catch (err) {
    logger.error({ error: err }, 'Failed to initialize chain client — anchor cron job will NOT start');
  }

  setupScheduledJobs(chainInitialized);
  setupGracefulShutdown(server);
});

export { app, server, trackOperation };
