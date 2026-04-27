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

import express, { Request, Response, NextFunction } from 'express';
import compression from 'compression';
import { config } from './config.js';
import { initSentry, Sentry } from './utils/sentry.js';
import { logger } from './utils/logger.js';
import { db, isDbHealthy, recordDbSuccess, recordDbFailure, getDbCircuitState, getConnectionInfo } from './utils/db.js';
import { callRpc } from './utils/rpc.js';
import { initChainClient } from './chain/client.js';
import { handleStripeWebhook } from './stripe/handlers.js';
import { verifyWebhookSignature } from './stripe/client.js';
import { rateLimiters } from './utils/rateLimit.js';
import { apiV1Router } from './api/v1/router.js';
import { v1DeprecationHeaders } from './api/v1/deprecation.js';
import { docsRouter } from './api/v1/docs.js';

// Extracted routers (ARCH-1)
import { billingRouter } from './routes/billing.js';
import { anchorRouter } from './routes/anchor.js';
import { adminRouter } from './routes/admin.js';
import { cronRouter } from './routes/cron.js';
import { identityRouter } from './api/v1/identity.js';
import { orgVerificationRouter } from './api/v1/orgVerification.js';
import { orgSubOrgsRouter } from './api/v1/orgSubOrgs.js';
import { orgKybRouter } from './api/v1/org-kyb.js';
import { driveOAuthRouter } from './api/v1/integrations/drive-oauth.js';
import { docusignOAuthRouter } from './api/v1/integrations/docusign-oauth.js';
import { middeskWebhookRouter } from './api/v1/webhooks/middesk.js';
import { docusignWebhookRouter } from './api/v1/webhooks/docusign.js';
import { adobeSignWebhookRouter } from './api/v1/webhooks/adobe-sign.js';
import { checkrWebhookRouter } from './api/v1/webhooks/checkr.js';
import { veremarkWebhookRouter } from './api/v1/webhooks/veremark.js';
import { cibaOpenApiSpec } from './api/v1/openapi-ciba.js';
import { atsWebhookRouter } from './api/v1/webhooks/ats.js';
import { corsMiddleware, requireAuth as requireAuthMw } from './routes/middleware.js';
import { globalErrorHandler } from './routes/errorHandler.js';
import { buildHealthResponse, type HealthCheckDeps } from './routes/health.js';
import { setupScheduledJobs } from './routes/scheduled.js';
import { setupGracefulShutdown, trackOperation } from './routes/lifecycle.js';
import { startHeapMonitor, logHeapStatus } from './utils/heapMonitor.js';
import { flagRegistry } from './middleware/flagRegistry.js';
import { correlationIdMiddleware } from './utils/correlationId.js';
import { requirePaymentCurrent } from './middleware/requirePaymentCurrent.js';
import { initUpstashRateLimiting } from './utils/upstashRateLimit.js';
import { createUpstashIdempotencyStore } from './middleware/upstashIdempotency.js';
import { setIdempotencyStore } from './middleware/idempotency.js';
import { createFeeEstimator } from './chain/fee-estimator.js';

// Initialize Sentry BEFORE Express app — PII scrubbing mandatory (Constitution 1.4 + 1.6)
initSentry(config.sentryDsn, config.nodeEnv);

// Static fee estimator singleton — avoids dynamic import on every /health request
const feeEstimatorInstance = createFeeEstimator({
  strategy: config.bitcoinFeeStrategy ?? 'static',
  staticRate: config.bitcoinStaticFeeRate,
  mempoolApiUrl: config.mempoolApiUrl,
  fallbackRate: config.bitcoinFallbackFeeRate,
});

const app = express();

// Disable x-powered-by header to prevent Express version disclosure
app.disable('x-powered-by');

// AUTH-03: Trust proxy for correct client IP behind Cloud Run / Cloudflare Tunnel
if (config.nodeEnv === 'production') {
  app.set('trust proxy', 2);
}

// ─── X-Request-Id on every response (DX-6) ───
app.use(correlationIdMiddleware);

// ─── Global CORS (BUG-UAT-12 / SCRUM-499) ───
// Apply CORS middleware globally so OPTIONS preflights are handled
// for ALL routes (health, billing, admin, anchor, cron, api/v1, etc.).
// Previously corsMiddleware was per-route which missed OPTIONS preflight.
app.use(corsMiddleware);

// ─── Health check — always available, no auth (Constitution 1.9) ───
// P7-TS-06: Enhanced with subsystem checks (anchoring, KMS, fee rate)
// BUG-UAT-12: CORS handled globally above (SCRUM-499)
app.get('/health', async (req, res) => {
  const detailed = req.query.detailed === 'true';

  const deps: HealthCheckDeps = {
    isDbHealthy,
    dbQuery: () => db.from('plans').select('id').limit(1) as unknown as Promise<{ data: unknown; error: { message: string } | null }>,
    recordDbSuccess,
    recordDbFailure,
    getDbCircuitState,
    getConnectionInfo,
    config: {
      bitcoinNetwork: config.bitcoinNetwork,
      stripeSecretKey: config.stripeSecretKey,
      sentryDsn: config.sentryDsn,
      geminiApiKey: config.geminiApiKey,
      aiProvider: config.aiProvider,
      kmsProvider: config.kmsProvider,
      bitcoinKmsKeyId: config.bitcoinKmsKeyId,
      gcpKmsKeyResourceName: config.gcpKmsKeyResourceName,
      bitcoinTreasuryWif: config.bitcoinTreasuryWif,
      enableProdNetworkAnchoring: config.enableProdNetworkAnchoring,
    },
    getLastSecuredAnchor: () =>
      db.from('anchors')
        .select('created_at')
        .eq('status', 'SECURED')
        .order('created_at', { ascending: false })
        .limit(1) as unknown as Promise<{ data: Array<{ created_at: string }> | null; error: { message: string } | null }>,
    getLastBatchAnchor: () =>
      db.from('anchors')
        .select('updated_at')
        .eq('status', 'SUBMITTED')
        .order('updated_at', { ascending: false })
        .limit(1) as unknown as Promise<{ data: Array<{ completed_at: string }> | null; error: { message: string } | null }>,
    getPendingAnchorCount: async () => {
      // SCRUM-1259 (R1-5): swapped exact-count on bloated anchors table
      // for get_anchor_status_counts_fast RPC. /health?detailed=true must
      // never include a >5s DB query (Cloud Run probe budget). The RPC has
      // a 1s per-status budget with sentinels so this stays sub-second.
      try {
        const { data, error } = await callRpc<{ PENDING: number }>(db, 'get_anchor_status_counts_fast');
        if (error || !data) {
          return { count: null, error: error ? { message: error.message } : null };
        }
        return { count: data.PENDING ?? null, error: null };
      } catch (err) {
        return { count: null, error: { message: err instanceof Error ? err.message : String(err) } };
      }
    },
    getCurrentFeeRate: async () => {
      // Best-effort fee rate — returns null if not available
      try {
        return await feeEstimatorInstance.estimateFee();
      } catch {
        return null;
      }
    },
  };

  const result = await buildHealthResponse(deps, detailed);

  if (result.statusCode === 503) {
    res.setHeader('Retry-After', '60');
  }
  res.status(result.statusCode).json(result.body);
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

// ─── Middesk webhook (SCRUM-1162) — raw body required for HMAC verify ───
// The router parses + verifies the signature internally. Mount raw parser
// here so `req.body` / `rawBody` contains the exact bytes Middesk signed.
app.use(
  '/webhooks/middesk',
  rateLimiters.stripeWebhook,
  express.raw({ type: 'application/json' }),
  (req, _res, next) => {
    // webhookHmac convention: expose rawBody explicitly (in case downstream
    // parses the body for logging etc.).
    (req as unknown as { rawBody: Buffer }).rawBody = req.body as Buffer;
    next();
  },
  middeskWebhookRouter,
);

// ─── DocuSign Connect webhook (SCRUM-1101) — raw body required for HMAC ───
import { killSwitch } from './middleware/integrationKillSwitch.js';
import { ruleEventBackpressure } from './middleware/ruleEventBackpressure.js';
app.use(
  '/webhooks/docusign',
  killSwitch('ENABLE_DOCUSIGN_WEBHOOK'),
  rateLimiters.stripeWebhook,
  ruleEventBackpressure, // SCRUM-1024: 503 + Retry-After if rule_events queue overloaded
  express.raw({ type: 'application/json' }),
  (req, _res, next) => {
    (req as unknown as { rawBody: Buffer }).rawBody = req.body as Buffer;
    next();
  },
  docusignWebhookRouter,
);

// ─── Adobe Sign webhook (SCRUM-1148) — raw body required for HMAC ───
app.use(
  '/webhooks/adobe-sign',
  rateLimiters.stripeWebhook,
  express.raw({ type: 'application/json' }),
  (req, _res, next) => {
    (req as unknown as { rawBody: Buffer }).rawBody = req.body as Buffer;
    next();
  },
  adobeSignWebhookRouter,
);

// ─── ATS webhook (SCRUM-1214/1215) — raw body for HMAC, per-integration URL ───
app.use(
  '/api/v1/webhooks/ats',
  rateLimiters.stripeWebhook,
  express.raw({ type: 'application/json' }),
  (req, _res, next) => {
    (req as unknown as { rawBody: Buffer }).rawBody = req.body as Buffer;
    req.body = JSON.parse((req.body as Buffer).toString('utf8'));
    next();
  },
  atsWebhookRouter,
);

// ─── Checkr report-completed webhook (SCRUM-1030 / 1151) — raw body required ───
app.use(
  '/webhooks/checkr',
  rateLimiters.stripeWebhook,
  express.raw({ type: 'application/json' }),
  (req, _res, next) => {
    (req as unknown as { rawBody: Buffer }).rawBody = req.body as Buffer;
    next();
  },
  checkrWebhookRouter,
);

// ─── Veremark webhook (SCRUM-1030 / 1151) — gated, defaults to 503 ───
app.use(
  '/webhooks/veremark',
  rateLimiters.stripeWebhook,
  express.raw({ type: 'application/json' }),
  (req, _res, next) => {
    (req as unknown as { rawBody: Buffer }).rawBody = req.body as Buffer;
    next();
  },
  veremarkWebhookRouter,
);

// ─── SCRUM-1122: CIBA OpenAPI spec (no auth, no rate limit — public docs) ───
app.get('/api/openapi-ciba.json', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(cibaOpenApiSpec);
});


// Gzip/brotli compression — 70-90% bandwidth reduction for JSON responses
app.use(compression({ threshold: 1024 }));

// JSON body parser for all other routes
app.use(express.json());

// ─── Mount routers (ARCH-1: each router owns its middleware) ───
app.use('/api', billingRouter);    // /api/checkout/session, /api/billing/portal
app.use('/api', anchorRouter);     // /api/verify-anchor, /api/recipients, /api/account
app.use('/api', adminRouter);      // /api/treasury/*, /api/admin/*
app.use('/jobs', cronRouter);      // /jobs/* (Cloud Scheduler + dev manual trigger)

// SCRUM-1270 (R2-7) — audit_events worker-only write path. Migration 0276
// REVOKEd browser INSERT; this is the replacement endpoint.
import { handleAuditEvent } from './api/audit-event.js';
app.post(
  '/api/audit/event',
  requireAuthMw,
  async (req: Request, res: Response) => {
    const userId = (req as Request & { userId?: string }).userId!;
    await handleAuditEvent(userId, { db, logger }, req, res);
  },
);

// API docs — no auth, no feature flag (P4.5-TS-04)
app.use('/api/docs', docsRouter);
app.get('/.well-known/openapi.json', (_req, res) => {
  res.redirect(301, '/api/docs/spec.json');
});

// 2026-04-26 — bug-bounty F4. Spec was already publicly inlined in
// `/api/docs/swagger-ui-init.js`, but `/api/v1/openapi.json` returned 401
// from the v1 auth middleware. The 401 implied restricted-disclosure where
// none existed; expose the same spec at the conventional path. MUST be
// registered before `app.use('/api/v1', apiV1Router)` so it bypasses v1
// auth middleware. Accepts no query params and no auth.
app.get('/api/v1/openapi.json', (_req, res) => {
  res.redirect(301, '/api/docs/spec.json');
});

// Agent-ready v2 OpenAPI 3.1 spec — public for tool importers.
import { apiV2OpenApiHandler } from './api/v2/openapi.js';
app.get('/v2/openapi.json', apiV2OpenApiHandler);

// v1 deprecation calendar — applies to every /api/v1 response, including side routers.
app.use('/api/v1', v1DeprecationHeaders);

// Identity & org verification — internal (frontend-facing), not behind feature gate
app.use('/api/v1/identity', rateLimiters.api, requireAuthMw, identityRouter);
app.use('/api/v1/org', rateLimiters.api, requireAuthMw, orgVerificationRouter);
app.use('/api/v1/org/sub-orgs', rateLimiters.api, requireAuthMw, orgSubOrgsRouter);
app.use('/api/v1/org-kyb', rateLimiters.api, requireAuthMw, orgKybRouter);
// Drive + DocuSign OAuth: /oauth/callback is hit by the provider with no
// Authorization header (state param holds the userId), so it must be public.
// All other routes require a logged-in user.
const integrationsAuthGate = (req: Request, res: Response, next: NextFunction) => {
  if (req.path.endsWith('/oauth/callback')) return next();
  return requireAuthMw(req, res, next);
};
app.use('/api/v1/integrations', killSwitch('ENABLE_DRIVE_OAUTH'), rateLimiters.api, integrationsAuthGate, driveOAuthRouter);
app.use('/api/v1/integrations', killSwitch('ENABLE_DOCUSIGN_OAUTH'), rateLimiters.api, integrationsAuthGate, docusignOAuthRouter);

// Payment-state enforcement: suspended/cancelled orgs get 402 (SCRUM-1221).
app.use('/api/v1', requirePaymentCurrent());

// Verification API v1 — gated behind ENABLE_VERIFICATION_API flag
app.use('/api/v1', apiV1Router);

// Verification API v2 — RFC 7807 error model, scoped API keys
app.use('/api/v2', requirePaymentCurrent());
import { apiV2Router } from './api/v2/router.js';
app.use('/api/v2', apiV2Router);

// Anchor revocation (SCRUM-1095) — requires auth, mounted under /api/anchor
import { anchorRevokeRouter } from './api/anchor-revoke.js';
app.use('/api/anchor', rateLimiters.api, requireAuthMw, anchorRevokeRouter);

// ─── 404 catch-all — JSON response for unmatched routes (BUG-14) ───
// Must be after all route mounts, before error handlers.
// Without this, Express returns plain text "Cannot GET /path" which breaks API clients.
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: 'not_found',
    message: `The requested endpoint does not exist. See /api/docs for available endpoints.`,
  });
});

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
  const redisRateInit = initUpstashRateLimiting();

  // IDEM-3: Initialize Redis-backed idempotency store (eliminates biggest heap consumer)
  const idempotencyRedisStore = createUpstashIdempotencyStore();
  if (idempotencyRedisStore) {
    setIdempotencyStore(idempotencyRedisStore);
    logger.info('Upstash Redis idempotency store initialized');
  } else if (!redisRateInit) {
    logger.info('Upstash Redis not configured — using in-memory stores (rate limit + idempotency)');
  }

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
  startHeapMonitor();
  logHeapStatus('startup');
});

export { app, server, trackOperation };
