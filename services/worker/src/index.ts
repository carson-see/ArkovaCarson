/**
 * Arkova Anchoring Worker
 *
 * Dedicated Node.js service for backend processing.
 * Per Constitution: Next.js API routes are forbidden.
 */

// Load environment variables FIRST before any other imports
import 'dotenv/config';

import express from 'express';
import cron from 'node-cron';
import { config } from './config.js';
import { initSentry, Sentry } from './utils/sentry.js';
import { logger } from './utils/logger.js';
import { db } from './utils/db.js';
import { callRpc } from './utils/rpc.js';
import { processPendingAnchors } from './jobs/anchor.js';
import { initChainClient } from './chain/client.js';
import { handleStripeWebhook } from './stripe/handlers.js';
import { verifyWebhookSignature, createCheckoutSession, createBillingPortalSession } from './stripe/client.js';
import { processWebhookRetries } from './webhooks/delivery.js';
import { processMonthlyCredits } from './jobs/credit-expiry.js';
import { rateLimiters, rateLimit } from './utils/rateLimit.js';
import { verifyAuthToken } from './auth.js';
import { apiV1Router } from './api/v1/router.js';
import { docsRouter } from './api/v1/docs.js';

// Initialize Sentry BEFORE Express app — PII scrubbing mandatory (Constitution 1.4 + 1.6)
initSentry(config.sentryDsn, config.nodeEnv);

const app = express();

// Disable x-powered-by header to prevent Express version disclosure
app.disable('x-powered-by');

// AUTH-03: Trust proxy for correct client IP behind Cloud Run / Cloudflare Tunnel
// 2 = trust up to 2 proxy hops (Cloudflare → Cloud Run load balancer → app)
if (config.nodeEnv === 'production') {
  app.set('trust proxy', 2);
}

// Health check endpoint — structured aggregation (AUDIT-18)
app.get('/health', async (req, res) => {
  const detailed = req.query.detailed === 'true';
  const checks: Record<string, { status: 'ok' | 'error'; latencyMs?: number; message?: string }> = {};

  // Critical check: Supabase connectivity (determines HTTP status code)
  const dbStart = Date.now();
  try {
    const { error } = await db.from('plans').select('id').limit(1);
    checks.supabase = {
      status: error ? 'error' : 'ok',
      latencyMs: Date.now() - dbStart,
      ...(error ? { message: error.message } : {}),
    };
  } catch (err) {
    checks.supabase = {
      status: 'error',
      latencyMs: Date.now() - dbStart,
      message: err instanceof Error ? err.message : 'Connection failed',
    };
  }

  // Informational checks — config presence, don't affect HTTP status
  const info: Record<string, { configured: boolean; message?: string }> = {};
  info.stripe = { configured: Boolean(config.stripeSecretKey) };
  info.sentry = {
    configured: Boolean(config.sentryDsn),
    ...(!config.sentryDsn ? { message: 'SENTRY_DSN not configured' } : {}),
  };
  info.ai = {
    configured: Boolean(config.geminiApiKey) || config.aiProvider === 'mock',
  };

  // Only critical checks determine healthy/degraded
  const allHealthy = Object.values(checks).every((c) => c.status === 'ok');

  // Compact format unless ?detailed=true
  const compactChecks: Record<string, 'ok' | 'error'> = {};
  for (const [key, val] of Object.entries(checks)) {
    compactChecks[key] = val.status;
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

// Stripe webhook endpoint — signature verified via constructEvent()
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

// JSON body parser for other routes
app.use(express.json());

// =========================================================================
// CORS for browser-facing billing routes
// =========================================================================
const CORS_ALLOWED_ORIGINS = config.frontendUrl
  ? [config.frontendUrl]
  : ['http://localhost:5173'];

function setCorsHeaders(req: express.Request, res: express.Response): boolean {
  const origin = req.headers.origin;
  if (origin && CORS_ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

// =========================================================================
// Auth helper — extract userId from Supabase JWT
// =========================================================================

/**
 * Extracts the authenticated user ID from the Authorization header.
 *
 * Uses verifyAuthToken from auth.ts which supports:
 * 1. Local JWT verification (when SUPABASE_JWT_SECRET is set) — no network call
 * 2. Supabase auth.getUser() fallback — when JWT secret is not configured
 */
async function extractAuthUserId(req: express.Request): Promise<string | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7);
  if (!token) {
    return null;
  }

  return verifyAuthToken(token, config, logger);
}

// CORS preflight for billing routes
app.options('/api/checkout/session', (req, res) => { setCorsHeaders(req, res); });
app.options('/api/billing/portal', (req, res) => { setCorsHeaders(req, res); });

// =========================================================================
// Billing API Routes (P7-TS-02)
// =========================================================================

/**
 * POST /api/checkout/session
 *
 * Creates a Stripe Checkout Session for subscription purchase.
 * Authenticates the user via Supabase JWT in Authorization header.
 * Looks up the plan from DB, gets user email from profiles,
 * then creates a checkout session via Stripe SDK.
 *
 * @header Authorization - Bearer <supabase-jwt>
 * @body planId - UUID of the plan from the plans table
 */
app.post('/api/checkout/session', rateLimiters.checkout, async (req, res) => {
  if (setCorsHeaders(req, res)) return;

  // Authenticate the user from the JWT — never trust client-supplied userId
  const userId = await extractAuthUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { planId } = req.body as { planId?: string };

  if (!planId) {
    res.status(400).json({ error: 'planId is required' });
    return;
  }

  try {
    // Look up the plan — only active plans can be used for checkout
    const { data: plan, error: planError } = await db
      .from('plans')
      .select('id, name, stripe_price_id, price_cents')
      .eq('id', planId)
      .eq('is_active', true)
      .single();

    if (planError || !plan) {
      logger.warn({ planId, planError }, 'Plan not found');
      res.status(404).json({ error: 'Plan not found' });
      return;
    }

    if (!plan.stripe_price_id) {
      logger.warn({ planId }, 'Plan has no Stripe price ID configured');
      res.status(400).json({ error: 'Plan is not available for online checkout' });
      return;
    }

    // Get user email from profiles
    const { data: profile, error: profileError } = await db
      .from('profiles')
      .select('email')
      .eq('id', userId)
      .single();

    if (profileError || !profile?.email) {
      logger.warn({ userId, profileError }, 'User profile or email not found');
      res.status(404).json({ error: 'User profile not found' });
      return;
    }

    // Check for existing active subscription
    const { data: existingSub } = await db
      .from('subscriptions')
      .select('id, status')
      .eq('user_id', userId)
      .in('status', ['active', 'trialing'])
      .maybeSingle();

    if (existingSub) {
      res.status(409).json({ error: 'User already has an active subscription. Use the billing portal to change plans.' });
      return;
    }

    const session = await createCheckoutSession({
      priceId: plan.stripe_price_id,
      userId,
      customerEmail: profile.email,
      successUrl: `${config.frontendUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${config.frontendUrl}/billing/cancel`,
    });

    logger.info({ userId, planId, sessionId: session.sessionId }, 'Checkout session created');
    res.json({ sessionId: session.sessionId, url: session.url });
  } catch (error) {
    logger.error({ error, planId, userId }, 'Failed to create checkout session');
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

/**
 * POST /api/billing/portal
 *
 * Creates a Stripe Billing Portal Session for subscription management.
 * Authenticates the user via Supabase JWT in Authorization header.
 * Looks up the user's Stripe customer ID from the subscriptions table.
 *
 * @header Authorization - Bearer <supabase-jwt>
 */
app.post('/api/billing/portal', rateLimiters.checkout, async (req, res) => {
  if (setCorsHeaders(req, res)) return;

  // Authenticate the user from the JWT — never trust client-supplied userId
  const userId = await extractAuthUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    // Look up user's Stripe customer ID from subscriptions
    const { data: subscription, error: subError } = await db
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .single();

    if (subError || !subscription?.stripe_customer_id) {
      logger.warn({ userId, subError }, 'No subscription found for user');
      res.status(404).json({ error: 'No active subscription found' });
      return;
    }

    const portal = await createBillingPortalSession({
      customerId: subscription.stripe_customer_id,
      returnUrl: `${config.frontendUrl}/settings`,
    });

    logger.info({ userId }, 'Billing portal session created');
    res.json({ url: portal.url });
  } catch (error) {
    logger.error({ error, userId }, 'Failed to create billing portal session');
    res.status(500).json({ error: 'Failed to create billing portal session' });
  }
});

// =========================================================================
// Public Anchor Verification (accepts fingerprint hash, NOT files)
// Constitution 1.6: Documents never leave the user's device.
// =========================================================================

app.post('/api/verify-anchor', rateLimiters.checkout, async (req, res) => {
  if (setCorsHeaders(req, res)) return;

  const { fingerprint } = req.body as { fingerprint?: string };

  if (!fingerprint) {
    res.status(400).json({ error: 'fingerprint is required (64-char hex SHA-256)' });
    return;
  }

  try {
    const { verifyAnchorByFingerprint } = await import('./api/verify-anchor.js');

    const lookup = {
      async lookupByFingerprint(fp: string) {
        const { data } = await db
          .from('anchors')
          .select('fingerprint, status, chain_tx_id, chain_block_height, chain_timestamp, public_id, created_at, credential_type')
          .eq('fingerprint', fp)
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!data) return null;

        return {
          fingerprint: data.fingerprint,
          status: data.status,
          chain_tx_id: data.chain_tx_id,
          chain_block_height: data.chain_block_height,
          chain_block_timestamp: data.chain_timestamp,
          public_id: data.public_id,
          created_at: data.created_at,
          credential_type: data.credential_type,
        };
      },
    };

    const result = await verifyAnchorByFingerprint(fingerprint, lookup);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Anchor verification failed');
    res.status(500).json({ error: 'Verification failed' });
  }
});

// CORS preflight for verify-anchor
app.options('/api/verify-anchor', (req, res) => { setCorsHeaders(req, res); });

// =========================================================================
// Account Deletion — GDPR Art. 17 Right to Erasure (PII-02)
// =========================================================================
app.options('/api/account', (req, res) => { setCorsHeaders(req, res); });

app.delete('/api/account', rateLimiters.checkout, async (req, res) => {
  if (setCorsHeaders(req, res)) return;

  const userId = await extractAuthUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const { handleAccountDelete } = await import('./api/account-delete.js');
    await handleAccountDelete(userId, { db, logger }, req, res);
  } catch (error) {
    logger.error({ error }, 'Account deletion failed');
    res.status(500).json({ error: 'Account deletion failed' });
  }
});

// =========================================================================
// Cron Job HTTP Endpoints — Cloud Scheduler (MVP-28) + dev manual trigger
// Authenticated via OIDC Bearer token in production, open in dev/test.
// Rate-limited to prevent replay/abuse (CodeQL: missing rate limiting).
// =========================================================================

// Dedicated rate limiter for cron endpoints — separate from user-facing limits
const cronJobsLimiter = rateLimit({
  windowMs: 60000,
  maxRequests: 5, // 5 req/min — cron fires at most every minute
  keyGenerator: () => 'cron-jobs', // Global limit (not per-IP)
});

/**
 * Verify cron job authentication (AUTH-01 hardening).
 *
 * Supports two auth methods (checked in order):
 * 1. CRON_SECRET header — `X-Cron-Secret: <shared-secret>`. Simple, works without Cloud Scheduler.
 * 2. OIDC Bearer token — Cloud Scheduler sends a Google-signed JWT. Verified via JWKS.
 *
 * In non-production (dev/test), requests are allowed without auth for local development.
 * In production, at least one auth method MUST succeed.
 */
async function verifyCronAuth(req: express.Request): Promise<boolean> {
  if (config.nodeEnv !== 'production') return true;

  // Method 1: Shared secret header (simplest — works with any HTTP client)
  const cronSecretHeader = req.headers['x-cron-secret'] as string | undefined;
  if (config.cronSecret && cronSecretHeader) {
    // Constant-time comparison to prevent timing attacks
    const expected = config.cronSecret;
    if (cronSecretHeader.length === expected.length) {
      let mismatch = 0;
      for (let i = 0; i < expected.length; i++) {
        mismatch |= cronSecretHeader.charCodeAt(i) ^ expected.charCodeAt(i);
      }
      if (mismatch === 0) return true;
    }
    logger.warn('Invalid X-Cron-Secret header');
    return false;
  }

  // Method 2: OIDC Bearer token from Cloud Scheduler
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7).trim();
  if (!token) return false;

  try {
    const { createRemoteJWKSet, jwtVerify } = await import('jose');
    const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
    // If no audience is configured, reject OIDC auth — without audience
    // validation, any Google-signed JWT would be accepted (jose skips aud check
    // when audience is undefined).
    if (!config.cronOidcAudience) {
      logger.warn('OIDC audience not configured — rejecting Bearer token');
      return false;
    }
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: 'https://accounts.google.com',
      audience: config.cronOidcAudience,
    });
    return Boolean(payload?.iss && payload?.exp);
  } catch (err) {
    logger.warn({ error: err }, 'OIDC token verification failed');
    return false;
  }
}

app.post('/jobs/process-anchors', cronJobsLimiter, async (req, res) => {
  if (!(await verifyCronAuth(req))) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    const result = await processPendingAnchors();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Anchor processing failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

app.post('/jobs/webhook-retries', cronJobsLimiter, async (req, res) => {
  if (!(await verifyCronAuth(req))) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    const retried = await processWebhookRetries();
    res.json({ retried });
  } catch (error) {
    logger.error({ error }, 'Webhook retry processing failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

app.post('/jobs/credit-expiry', cronJobsLimiter, async (req, res) => {
  if (!(await verifyCronAuth(req))) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    const processed = await processMonthlyCredits();
    res.json({ processed });
  } catch (error) {
    logger.error({ error }, 'Credit expiry processing failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// =========================================================================
// Treasury Status — Arkova platform admin only (feedback_treasury_access)
// =========================================================================
app.options('/api/treasury/status', (req, res) => { setCorsHeaders(req, res); });

app.get('/api/treasury/status', rateLimiters.checkout, async (req, res) => {
  if (setCorsHeaders(req, res)) return;

  const userId = await extractAuthUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const { handleTreasuryStatus } = await import('./api/treasury.js');
    await handleTreasuryStatus(userId, req, res);
  } catch (error) {
    logger.error({ error }, 'Treasury status request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =========================================================================
// API Documentation — accessible without auth or feature flag (P4.5-TS-04)
// =========================================================================
app.use('/api/docs', docsRouter);

// Agent discoverability — .well-known endpoint for OpenAPI spec (no auth, no feature gate)
app.get('/.well-known/openapi.json', (_req, res) => {
  res.redirect(301, '/api/docs/spec.json');
});

// =========================================================================
// Verification API v1 (P4.5) — gated behind ENABLE_VERIFICATION_API flag
// =========================================================================
app.use('/api/v1', apiV1Router);

// Sentry Express error handler — must be after all routes, before other error handlers
Sentry.setupExpressErrorHandler(app);

// Scheduled jobs
// In production, Cloud Scheduler triggers HTTP endpoints (MVP-28) — in-process cron is a
// belt-and-suspenders backup for dev/test. To avoid duplicate chain submissions, disable
// in-process anchor cron in production (Cloud Scheduler is authoritative).
function setupScheduledJobs(chainInitialized: boolean): void {
  // Process pending anchors every minute — only in non-production (dev/test backup)
  // In production, Cloud Scheduler calls POST /jobs/process-anchors instead.
  if (chainInitialized && config.nodeEnv !== 'production') {
    cron.schedule('* * * * *', async () => {
      logger.debug('Running scheduled anchor processing (in-process cron)');
      try {
        await processPendingAnchors();
      } catch (error) {
        logger.error({ error }, 'Scheduled anchor processing failed');
      }
    });
  } else if (!chainInitialized) {
    logger.warn('Anchor processing cron DISABLED — chain client not initialized');
  } else {
    logger.info('Anchor processing cron DISABLED in production — Cloud Scheduler is authoritative');
  }

  // Process webhook retries every 2 minutes
  cron.schedule('*/2 * * * *', async () => {
    logger.debug('Running scheduled webhook retry processing');
    try {
      const retried = await processWebhookRetries();
      if (retried > 0) {
        logger.info({ retried }, 'Processed webhook retries');
      }
    } catch (error) {
      logger.error({ error }, 'Scheduled webhook retry processing failed');
    }
  });

  // Process monthly credit allocations on the 1st of each month at midnight (MVP-25)
  cron.schedule('0 0 1 * *', async () => {
    logger.info('Running monthly credit allocation');
    try {
      const processed = await processMonthlyCredits();
      logger.info({ processed }, 'Monthly credit allocation complete');
    } catch (error) {
      logger.error({ error }, 'Monthly credit allocation failed');
    }
  });

  // PII-03: GDPR data retention cleanup — daily at 2:00 AM UTC
  // Enforces retention policy defined in cleanup_expired_data() RPC (migration 0062):
  //   - webhook_delivery_logs: 90 days
  //   - verification_events: 1 year
  //   - ai_usage_events: 1 year
  //   - audit_events: 2 years (except legal hold)
  cron.schedule('0 2 * * *', async () => {
    logger.info('Running GDPR data retention cleanup');
    try {
      const { data: result, error } = await callRpc(db, 'cleanup_expired_data');
      if (error) {
        logger.error({ error }, 'Data retention cleanup RPC failed');
      } else {
        logger.info({ result }, 'Data retention cleanup complete');
      }
    } catch (error) {
      logger.error({ error }, 'Data retention cleanup failed');
    }
  });

  logger.info('Scheduled jobs configured');
}

// Graceful shutdown
function setupGracefulShutdown(): void {
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info({ signal }, 'Received shutdown signal');

    // Force exit after 30 seconds if server.close() hangs
    const forceTimer = setTimeout(() => {
      logger.warn('Forcing shutdown after timeout');
      process.exit(1);
    }, 30000);
    forceTimer.unref();

    // Stop accepting new requests, then exit after in-flight requests drain
    server.close(() => {
      logger.info('HTTP server closed — all connections drained');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Start server
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

  // Initialize chain client singleton (async — KMS key init may need network call)
  let chainInitialized = false;
  try {
    await initChainClient();
    logger.info('Chain client initialized');
    chainInitialized = true;
  } catch (err) {
    logger.error({ error: err }, 'Failed to initialize chain client — anchor cron job will NOT start');
  }

  setupScheduledJobs(chainInitialized);
  setupGracefulShutdown();
});

export { app, server };
