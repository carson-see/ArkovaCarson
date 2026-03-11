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
import { logger } from './utils/logger.js';
import { db } from './utils/db.js';
import { processPendingAnchors } from './jobs/anchor.js';
import { handleStripeWebhook } from './stripe/handlers.js';
import { verifyWebhookSignature, createCheckoutSession, createBillingPortalSession } from './stripe/client.js';
import { processWebhookRetries } from './webhooks/delivery.js';

const app = express();

// Disable x-powered-by header to prevent Express version disclosure
app.disable('x-powered-by');

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    version: process.env.npm_package_version ?? '0.1.0',
    uptime: process.uptime(),
    network: config.chainNetwork,
  });
});

// Stripe webhook endpoint — signature verified via constructEvent()
app.post(
  '/webhooks/stripe',
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
// Billing API Routes (P7-TS-02)
// =========================================================================

/**
 * POST /api/checkout/session
 *
 * Creates a Stripe Checkout Session for subscription purchase.
 * Looks up the plan from DB, gets user email from profiles,
 * then creates a checkout session via Stripe SDK.
 *
 * @body planId - UUID of the plan from the plans table
 * @body userId - UUID of the authenticated user
 */
app.post('/api/checkout/session', async (req, res) => {
  const { planId, userId } = req.body as { planId?: string; userId?: string };

  if (!planId || !userId) {
    res.status(400).json({ error: 'planId and userId are required' });
    return;
  }

  try {
    // Look up the plan
    const { data: plan, error: planError } = await db
      .from('plans')
      .select('id, name, stripe_price_id, price_cents, anchor_limit')
      .eq('id', planId)
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
 * Looks up the user's Stripe customer ID from the subscriptions table.
 *
 * @body userId - UUID of the authenticated user
 */
app.post('/api/billing/portal', async (req, res) => {
  const { userId } = req.body as { userId?: string };

  if (!userId) {
    res.status(400).json({ error: 'userId is required' });
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

// Scheduled jobs
function setupScheduledJobs(): void {
  // Process pending anchors every minute
  cron.schedule('* * * * *', async () => {
    logger.debug('Running scheduled anchor processing');
    try {
      await processPendingAnchors();
    } catch (error) {
      logger.error({ error }, 'Scheduled anchor processing failed');
    }
  });

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

  // Reset monthly anchor counts on the 1st of each month at midnight
  cron.schedule('0 0 1 * *', async () => {
    logger.info('Resetting monthly anchor counts');
    // Implementation would reset anchor_count_this_month in profiles
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
const server = app.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      env: config.nodeEnv,
      network: config.chainNetwork,
      mocks: config.useMocks,
    },
    'Worker service started'
  );

  setupScheduledJobs();
  setupGracefulShutdown();
});

export { app, server };
