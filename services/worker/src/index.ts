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
import { processPendingAnchors } from './jobs/anchor.js';
import { handleStripeWebhook } from './stripe/handlers.js';
import { verifyWebhookSignature } from './stripe/client.js';

const app = express();

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
