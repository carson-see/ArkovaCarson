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
import { processPendingAnchors } from './jobs/anchor.js';
import { initChainClient } from './chain/client.js';
import { handleStripeWebhook } from './stripe/handlers.js';
import { verifyWebhookSignature, createCheckoutSession, createBillingPortalSession } from './stripe/client.js';
import { processWebhookRetries } from './webhooks/delivery.js';
import { processMonthlyCredits } from './jobs/credit-expiry.js';
import { rateLimiters } from './utils/rateLimit.js';
import { verifyAuthToken } from './auth.js';

// Initialize Sentry BEFORE Express app — PII scrubbing mandatory (Constitution 1.4 + 1.6)
initSentry(config.sentryDsn, config.nodeEnv);

const app = express();

// Disable x-powered-by header to prevent Express version disclosure
app.disable('x-powered-by');

// Health check endpoint — enhanced for production monitoring (H3-08)
app.get('/health', async (_req, res) => {
  const checks: Record<string, 'ok' | 'error'> = {};

  // Shallow Supabase connectivity check
  try {
    const { error } = await db.from('plans').select('id').limit(1);
    checks.supabase = error ? 'error' : 'ok';
  } catch {
    checks.supabase = 'error';
  }

  const allHealthy = Object.values(checks).every((v) => v === 'ok');

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'healthy' : 'degraded',
    version: process.env.npm_package_version ?? '0.1.0',
    uptime: Math.floor(process.uptime()),
    network: config.bitcoinNetwork,
    checks,
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
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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

// Manual trigger for anchor processing (for testing)
app.post('/jobs/process-anchors', async (_req, res) => {
  try {
    const result = await processPendingAnchors();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Manual anchor processing failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// Sentry Express error handler — must be after all routes, before other error handlers
Sentry.setupExpressErrorHandler(app);

// Scheduled jobs
function setupScheduledJobs(chainInitialized: boolean): void {
  // Process pending anchors every minute — only if chain client initialized
  if (chainInitialized) {
    cron.schedule('* * * * *', async () => {
      logger.debug('Running scheduled anchor processing');
      try {
        await processPendingAnchors();
      } catch (error) {
        logger.error({ error }, 'Scheduled anchor processing failed');
      }
    });
  } else {
    logger.warn('Anchor processing cron DISABLED — chain client not initialized');
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

  logger.info('Scheduled jobs configured');
}

// Graceful shutdown
function setupGracefulShutdown(): void {
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal');

    // Stop accepting new requests
    server.close(() => {
      logger.info('HTTP server closed');
    });

    // Allow ongoing requests to complete (30 second timeout)
    setTimeout(() => {
      logger.warn('Forcing shutdown after timeout');
      process.exit(1);
    }, 30000);

    process.exit(0);
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
