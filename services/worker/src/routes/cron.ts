/**
 * Cron Job HTTP Routes
 *
 * Cloud Scheduler (MVP-28) + dev manual trigger endpoints.
 * Authenticated via OIDC Bearer token or CRON_SECRET in production.
 * Rate-limited to prevent replay/abuse.
 *
 * Extracted from index.ts as part of ARCH-1 refactor.
 * ARCH-2: Each job handler uses pg_advisory_lock where applicable.
 */

import { Router, Request } from 'express';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { rateLimit } from '../utils/rateLimit.js';
import { db } from '../utils/db.js';
import { callRpc } from '../utils/rpc.js';
import { verifyAuthToken } from '../auth.js';
import { isPlatformAdmin } from '../utils/platformAdmin.js';
import { processPendingAnchors } from '../jobs/anchor.js';
import { checkSubmittedConfirmations } from '../jobs/check-confirmations.js';
import { processRevokedAnchors } from '../jobs/revocation.js';
import { processWebhookRetries } from '../webhooks/delivery.js';
import { processMonthlyCredits } from '../jobs/credit-expiry.js';
import { fetchEdgarFilings, fetchEdgarHistoricalBackfill } from '../jobs/edgarFetcher.js';
import { fetchUsptoPAtents } from '../jobs/usptoFetcher.js';
import { fetchFederalRegisterDocuments } from '../jobs/federalRegisterFetcher.js';
import { fetchOpenAlexWorks } from '../jobs/openalexFetcher.js';
import { processPublicRecordAnchoring } from '../jobs/publicRecordAnchor.js';
import { embedPublicRecords } from '../jobs/publicRecordEmbedder.js';
import { processAttestationAnchoring } from '../jobs/attestationAnchor.js';
import { fetchDapipInstitutions } from '../jobs/dapipFetcher.js';
import { processBatchAnchors } from '../jobs/batch-anchor.js';
import { fetchAcncCharities } from '../jobs/acncFetcher.js';
import { detectReorgs, monitorStuckTransactions, rebroadcastDroppedTransactions, consolidateUtxos, monitorFeeRates } from '../jobs/chain-maintenance.js';
import { runStripeAnchorReconciliation, generateFinancialReport, processFailedPaymentRecovery } from '../billing/reconciliation.js';

export const cronRouter = Router();

// CORS for browser-based admin triggers (PipelineAdminPage)
import { corsMiddleware } from './middleware.js';
cronRouter.use(corsMiddleware);

// Dedicated rate limiter for cron endpoints
const cronJobsLimiter = rateLimit({
  windowMs: 60000,
  maxRequests: 30,
  keyGenerator: () => 'cron-jobs',
});

cronRouter.use(cronJobsLimiter);

/**
 * Verify cron job authentication (AUTH-01 hardening).
 *
 * Supports three auth methods:
 * 1. CRON_SECRET header — constant-time comparison
 * 2. OIDC Bearer token — Google-signed JWT verified via JWKS
 * 3. Platform admin Bearer token — Supabase JWT for admin dashboard triggers
 *
 * Non-production: open for local development.
 */
async function verifyCronAuth(req: Request): Promise<boolean> {
  if (config.nodeEnv !== 'production') return true;

  // Method 1: Shared secret header
  const cronSecretHeader = req.headers['x-cron-secret'] as string | undefined;
  if (config.cronSecret && cronSecretHeader) {
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

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7).trim();
  if (!token) return false;

  // Method 2: Platform admin Bearer token (for dashboard pipeline triggers)
  try {
    const userId = await verifyAuthToken(token, config, logger);
    if (userId) {
      const isAdmin = await isPlatformAdmin(userId);
      if (isAdmin) return true;
    }
  } catch {
    // Fall through to OIDC check
  }

  // Method 3: OIDC Bearer token from Cloud Scheduler
  try {
    const { createRemoteJWKSet, jwtVerify } = await import('jose');
    const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
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

/** Middleware that enforces cron authentication */
async function cronAuth(req: Request, res: any, next: any): Promise<void> {
  if (!(await verifyCronAuth(req))) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

// Apply cron auth to all routes in this router
cronRouter.use(cronAuth);

// ─── Core Anchoring Jobs ───

cronRouter.post('/process-anchors', async (_req, res) => {
  try {
    const result = await processPendingAnchors();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Anchor processing failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/batch-anchors', async (_req, res) => {
  try {
    const result = await processBatchAnchors();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Batch anchor processing failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/check-confirmations', async (_req, res) => {
  try {
    const result = await checkSubmittedConfirmations();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Confirmation check failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/process-revocations', async (_req, res) => {
  try {
    const result = await processRevokedAnchors();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Revocation processing failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/webhook-retries', async (_req, res) => {
  try {
    const retried = await processWebhookRetries();
    res.json({ retried });
  } catch (error) {
    logger.error({ error }, 'Webhook retry processing failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/credit-expiry', async (_req, res) => {
  try {
    const processed = await processMonthlyCredits();
    res.json({ processed });
  } catch (error) {
    logger.error({ error }, 'Credit expiry processing failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── Phase 1.5 Pipeline Jobs ───

cronRouter.post('/fetch-edgar', async (_req, res) => {
  try {
    const result = await fetchEdgarFilings(db);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'EDGAR fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/fetch-uspto', async (_req, res) => {
  try {
    await fetchUsptoPAtents(db);
    res.json({ status: 'complete' });
  } catch (error) {
    logger.error({ error }, 'USPTO fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/fetch-federal-register', async (_req, res) => {
  try {
    await fetchFederalRegisterDocuments(db);
    res.json({ status: 'complete' });
  } catch (error) {
    logger.error({ error }, 'Federal Register fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/fetch-openalex', async (_req, res) => {
  try {
    const result = await fetchOpenAlexWorks(db);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'OpenAlex fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/embed-public-records', async (_req, res) => {
  try {
    const result = await embedPublicRecords();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Public record embedding failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/anchor-public-records', async (_req, res) => {
  try {
    const result = await processPublicRecordAnchoring();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Public record anchoring failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/edgar-backfill', async (req, res) => {
  try {
    const batchIndex = parseInt(String(req.query.batch ?? req.body?.batch ?? '0'), 10);
    const result = await fetchEdgarHistoricalBackfill(db, batchIndex);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'EDGAR historical backfill failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/fetch-dapip', async (_req, res) => {
  try {
    const result = await fetchDapipInstitutions(db);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'DAPIP fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/fetch-acnc', async (_req, res) => {
  try {
    const result = await fetchAcncCharities(db);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'ACNC fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/anchor-attestations', async (_req, res) => {
  try {
    const result = await processAttestationAnchoring();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Attestation anchoring failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── Bitcoin Audit: Chain Maintenance Jobs ───

cronRouter.post('/detect-reorgs', async (_req, res) => {
  try {
    const result = await detectReorgs();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Reorg detection failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/monitor-stuck-txs', async (_req, res) => {
  try {
    const result = await monitorStuckTransactions();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Stuck TX monitor failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/rebroadcast-txs', async (_req, res) => {
  try {
    const result = await rebroadcastDroppedTransactions();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'TX rebroadcast failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/consolidate-utxos', async (_req, res) => {
  try {
    const result = await consolidateUtxos();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'UTXO consolidation failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/monitor-fees', async (_req, res) => {
  try {
    const result = await monitorFeeRates();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Fee monitoring failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── Billing Reconciliation & Recovery (RECON-1, RECON-3, RECON-5) ───

cronRouter.post('/reconcile-stripe', async (_req, res) => {
  try {
    const result = await runStripeAnchorReconciliation();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Stripe reconciliation failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/financial-report', async (_req, res) => {
  try {
    const result = await generateFinancialReport();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Financial report generation failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/payment-recovery', async (_req, res) => {
  try {
    const result = await processFailedPaymentRecovery();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Payment recovery failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── GDPR data retention cleanup ───
cronRouter.post('/cleanup-retention', async (_req, res) => {
  try {
    const { data: result, error } = await callRpc(db, 'cleanup_expired_data');
    if (error) {
      logger.error({ error }, 'Data retention cleanup RPC failed');
      res.status(500).json({ error: 'Processing failed' });
      return;
    }
    res.json({ result });
  } catch (error) {
    logger.error({ error }, 'Data retention cleanup failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});
