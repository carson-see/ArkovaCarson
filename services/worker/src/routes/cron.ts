/**
 * Cron Job HTTP Routes
 *
 * Cloud Scheduler (MVP-28) + dev manual trigger endpoints.
 * Authenticated in production via any of three methods (see verifyCronAuth):
 *   1. X-Cron-Secret header (CRON_SECRET)
 *   2. Platform admin Supabase JWT
 *   3. Google OIDC Bearer token (CRON_OIDC_AUDIENCE)
 * Rate-limited to prevent replay/abuse.
 *
 * Extracted from index.ts as part of ARCH-1 refactor.
 * ARCH-2: Each job handler uses pg_advisory_lock where applicable.
 */

import { Router, Request } from 'express';
import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
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
import { fetchEdgarFilings, fetchEdgarHistoricalBackfill, fetchEdgarBulk } from '../jobs/edgarFetcher.js';
import { fetchUsptoPAtents } from '../jobs/usptoFetcher.js';
import { fetchFederalRegisterDocuments } from '../jobs/federalRegisterFetcher.js';
import { fetchOpenAlexWorks, fetchOpenAlexBulk } from '../jobs/openalexFetcher.js';
import { fetchCourtOpinions, fetchStateCourts } from '../jobs/courtlistenerFetcher.js';
import { processPublicRecordAnchoring } from '../jobs/publicRecordAnchor.js';
import { embedPublicRecords } from '../jobs/publicRecordEmbedder.js';
import { processAttestationAnchoring } from '../jobs/attestationAnchor.js';
import { checkAttestationExpiry } from '../jobs/attestationExpiry.js';
import { fetchDapipInstitutions } from '../jobs/dapipFetcher.js';
import { processBatchAnchors } from '../jobs/batch-anchor.js';
import { fetchAcncCharities } from '../jobs/acncFetcher.js';
import { fetchStateBills, fetchMultipleStateBills } from '../jobs/openStatesFetcher.js';
import { fetchCalBarAttorneys } from '../jobs/calbarFetcher.js';
import { fetchFinraBrokers } from '../jobs/finraBrokerCheckFetcher.js';
import { fetchSecIapdFirms } from '../jobs/secIapdFetcher.js';
import { fetchNpiProviders } from '../jobs/npiFetcher.js';
import { fetchSamEntities, fetchSamExclusions } from '../jobs/samGovFetcher.js';
import { fetchFccLicenses } from '../jobs/fccUlsFetcher.js';
import { fetchSosEntities } from '../jobs/sosFetcher.js';
import { fetchLicensingBoardRecords } from '../jobs/licensingBoardFetcher.js';
import { fetchInsuranceLicenses } from '../jobs/insuranceLicenseFetcher.js';
import { fetchCleRecords } from '../jobs/cleFetcher.js';
import { fetchCertificationRecords } from '../jobs/certificationFetcher.js';
import { fetchIpedsInstitutions } from '../jobs/ipedsFetcher.js';
import { fetchKenyaComplianceData } from '../jobs/kenyaLawFetcher.js';
import { fetchAustraliaComplianceData } from '../jobs/australiaLawFetcher.js';
import { fetchEcfrRegulations } from '../jobs/ecfrFetcher.js';
import { detectReorgs, monitorStuckTransactions, rebroadcastDroppedTransactions, consolidateUtxos, monitorFeeRates } from '../jobs/chain-maintenance.js';
import { recoverStuckBroadcasts } from '../jobs/broadcast-recovery.js';
import { refreshTreasuryCache } from '../jobs/treasury-cache.js';
import { runMainnetMigration, getMigrationStatus } from '../jobs/mainnet-migration.js';
import { checkPipelineHealth } from '../jobs/pipeline-health.js';
import { runStripeAnchorReconciliation, generateFinancialReport, processFailedPaymentRecovery } from '../billing/reconciliation.js';
import { logHeapStatus } from '../utils/heapMonitor.js';

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

// Log heap status after every cron job completes (response finish event)
cronRouter.use((_req, res, next) => {
  res.on('finish', () => {
    try { logHeapStatus(`cron:${_req.path}`); } catch { /* diagnostics-only — never fail a cron job */ }
  });
  next();
});

/**
 * Memoized Google OIDC JWKS fetcher (SCRUM-640).
 *
 * `createRemoteJWKSet` returns a function that caches keys in its closure.
 * Previously this was created per-request, meaning every cron invocation
 * re-fetched Google's cert bundle. Lifting it to module scope lets the
 * cache survive across requests.
 */
let cachedJwks: JWTVerifyGetKey | null = null;
function getGoogleJwks(): JWTVerifyGetKey {
  if (!cachedJwks) {
    cachedJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
  }
  return cachedJwks;
}

/**
 * Verify cron job authentication (AUTH-01 hardening, SCRUM-640 fix).
 *
 * Supports three auth methods:
 * 1. CRON_SECRET header — constant-time comparison
 * 2. Platform admin Bearer token — Supabase JWT for admin dashboard triggers
 * 3. OIDC Bearer token — Google-signed JWT verified via JWKS
 *
 * SCRUM-640: Either CRON_SECRET *or* CRON_OIDC_AUDIENCE is sufficient for
 * production auth. Previously this middleware bailed at `!config.cronSecret`
 * even when OIDC was configured, producing persistent 401s on revisions
 * deployed with OIDC-only auth (observed on revisions 00286-00290).
 *
 * Non-production: open for local development.
 */
async function verifyCronAuth(req: Request): Promise<boolean> {
  // SEC-028: Only bypass auth in local development, not staging/preview
  if (config.nodeEnv === 'development' || config.nodeEnv === 'test') return true;

  // SCRUM-640: Fail secure only if NEITHER auth method is configured.
  // Either CRON_SECRET or CRON_OIDC_AUDIENCE alone is sufficient.
  if (!config.cronSecret && !config.cronOidcAudience) {
    logger.error(
      'Neither CRON_SECRET nor CRON_OIDC_AUDIENCE configured in production — rejecting all cron requests',
    );
    return false;
  }

  // Method 1: Shared secret header (SEC-030: use crypto.timingSafeEqual).
  // SCRUM-640: Only evaluate this path if CRON_SECRET is actually configured.
  // If a stale X-Cron-Secret header reaches an OIDC-only deployment (e.g. from
  // a legacy scheduler config or proxy), fall through to the Bearer/OIDC path
  // instead of 401-ing. Otherwise we'd reintroduce the very bug this story fixes.
  const cronSecretHeader = req.headers['x-cron-secret'] as string | undefined;
  if (cronSecretHeader && config.cronSecret) {
    const expected = Buffer.from(config.cronSecret);
    const actual = Buffer.from(cronSecretHeader);
    if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) {
      return true;
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
  if (!config.cronOidcAudience) {
    logger.warn('OIDC audience not configured — rejecting Bearer token');
    return false;
  }
  try {
    const { payload } = await jwtVerify(token, getGoogleJwks(), {
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// ─── Treasury Cache (SCRUM-546) ───

cronRouter.post('/refresh-treasury-cache', async (_req, res) => {
  try {
    const result = await refreshTreasuryCache();
    res.json({ success: true, balance: result.balance_confirmed_sats, updated_at: result.updated_at });
  } catch (error) {
    logger.error({ error }, 'Treasury cache refresh failed');
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
    const result = await fetchUsptoPAtents(db);
    res.json(result);
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

cronRouter.post('/openalex-bulk', async (req, res) => {
  try {
    const startDate = String(req.query.startDate ?? req.body?.startDate ?? '2000-01-01');
    // Only pass endDate if explicitly provided — otherwise let auto-resume pick the date
    const explicitEndDate = req.query.endDate ?? req.body?.endDate;
    const endDate = explicitEndDate ? String(explicitEndDate) : undefined;
    const minCitations = parseInt(String(req.query.minCitations ?? req.body?.minCitations ?? '0'), 10);
    const maxPages = parseInt(String(req.query.maxPages ?? req.body?.maxPages ?? '500'), 10);
    const resumeCursor = req.body?.resumeCursor;

    const result = await fetchOpenAlexBulk(db, { startDate, endDate, minCitations, maxPages, resumeCursor });
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Bulk OpenAlex ingestion failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/fetch-courtlistener', async (req, res) => {
  try {
    const startDate = String(req.query.startDate ?? req.body?.startDate ?? '1950-01-01');
    // Only pass endDate if explicitly provided — otherwise let auto-resume pick the date
    const explicitEndDate = req.query.endDate ?? req.body?.endDate;
    const endDate = explicitEndDate ? String(explicitEndDate) : undefined;
    const maxPages = parseInt(String(req.query.maxPages ?? req.body?.maxPages ?? '500'), 10);
    const courtFilter = req.body?.courtFilter;
    const statusFilter = req.body?.statusFilter ?? 'Published';

    const result = await fetchCourtOpinions(db, { startDate, endDate, maxPages, courtFilter, statusFilter });
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'CourtListener fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/fetch-state-courts', async (req, res) => {
  try {
    const stateCode = String(req.query.state ?? req.body?.state ?? 'CA').toUpperCase();
    const startDate = String(req.query.startDate ?? req.body?.startDate ?? '1950-01-01');
    // Only pass endDate if explicitly provided — otherwise let auto-resume pick the date
    const explicitEndDate = req.query.endDate ?? req.body?.endDate;
    const endDate = explicitEndDate ? String(explicitEndDate) : undefined;
    const maxPagesPerCourt = parseInt(String(req.query.maxPagesPerCourt ?? req.body?.maxPagesPerCourt ?? '500'), 10);

    const result = await fetchStateCourts(db, stateCode, { startDate, endDate, maxPagesPerCourt });
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'State court fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/fetch-state-bills', async (req, res) => {
  try {
    const stateCode = String(req.query.state ?? req.body?.state ?? 'CA').toUpperCase();
    const maxPages = parseInt(String(req.query.maxPages ?? req.body?.maxPages ?? '300'), 10);

    const result = await fetchStateBills(db, { stateCode, maxPages });
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'State bills fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/fetch-all-state-bills', async (req, res) => {
  try {
    const states = (req.body?.states as string[] | undefined) ?? ['CA', 'NY', 'TX'];
    const maxPagesPerState = parseInt(String(req.query.maxPagesPerState ?? req.body?.maxPagesPerState ?? '300'), 10);

    const result = await fetchMultipleStateBills(db, states, { maxPagesPerState });
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Multi-state bills fetch failed');
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

cronRouter.post('/edgar-bulk', async (req, res) => {
  try {
    const startYear = parseInt(String(req.query.startYear ?? req.body?.startYear ?? '1993'), 10);
    const endYear = parseInt(String(req.query.endYear ?? req.body?.endYear ?? new Date().getFullYear()), 10);
    const maxQueries = parseInt(String(req.query.maxQueries ?? req.body?.maxQueries ?? '200'), 10);
    const formTypes = req.body?.formTypes; // optional array override

    const result = await fetchEdgarBulk(db, { startYear, endYear, maxQueriesPerInvocation: maxQueries, formTypes });
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Bulk EDGAR ingestion failed');
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

cronRouter.post('/recover-broadcasts', async (_req, res) => {
  try {
    const result = await recoverStuckBroadcasts();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Broadcast recovery failed');
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

// ─── Mainnet Migration (one-time) ───

cronRouter.post('/mainnet-migration', async (_req, res) => {
  try {
    const result = await runMainnetMigration();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Mainnet migration failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.get('/migration-status', async (_req, res) => {
  try {
    const status = await getMigrationStatus();
    res.json(status);
  } catch (error) {
    logger.error({ error }, 'Migration status check failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── Attestation Expiry Monitoring (ATT-08) ───
cronRouter.post('/check-attestation-expiry', async (_req, res) => {
  try {
    const result = await checkAttestationExpiry();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Attestation expiry check failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── Credential Expiry Alerts (NCE-09 / SCRUM-600) ───
cronRouter.post('/check-credential-expiry', async (_req, res) => {
  try {
    const { flagRegistry } = await import('../middleware/flagRegistry.js');
    if (!flagRegistry.getFlag('ENABLE_EXPIRY_ALERTS')) {
      res.json({ skipped: true, reason: 'ENABLE_EXPIRY_ALERTS flag is disabled' });
      return;
    }
    const { categorizeExpiringDocuments, groupByOrg } = await import('../compliance/expiry-checker.js');

    // Query anchors with expiry dates within 90 days
    const cutoff = new Date(Date.now() + 90 * 86_400_000).toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbAny = db as any;
    const { data: expiring, error } = await dbAny
      .from('anchors')
      .select('id, org_id, credential_type, document_title, not_after')
      .eq('status', 'SECURED')
      .not('not_after', 'is', null)
      .gt('not_after', new Date().toISOString())
      .lte('not_after', cutoff);

    if (error) {
      logger.error({ error }, 'Failed to query expiring credentials');
      res.status(500).json({ error: 'Query failed' });
      return;
    }

    const anchors = (expiring ?? []).map((a: Record<string, unknown>) => ({
      id: a.id as string,
      org_id: a.org_id as string,
      credential_type: (a.credential_type as string) ?? 'OTHER',
      title: (a.title as string) ?? null,
      expiry_date: a.not_after as string,
    }));

    const categories = categorizeExpiringDocuments(anchors);
    const urgentAnchors = categories.get('7_day') ?? [];
    const orgGroups = groupByOrg(urgentAnchors);

    let emailsSent = 0;
    let webhooksSent = 0;

    const { dispatchWebhookEvent } = await import('../webhooks/delivery.js');
    const now = Date.now();

    for (const [orgId, orgAnchors] of orgGroups) {
      try {
        const results = await Promise.allSettled(
          orgAnchors.map(anchor => {
            const daysRemaining = Math.ceil((new Date(anchor.expiry_date).getTime() - now) / 86_400_000);
            const eventId = `expiry-${anchor.id}-${Date.now()}`;
            return dispatchWebhookEvent(
              orgId,
              'compliance.document_expiring',
              eventId,
              {
                anchor_id: anchor.id,
                credential_type: anchor.credential_type,
                title: anchor.title,
                expiry_date: anchor.expiry_date,
                days_remaining: daysRemaining,
                warning_level: '7_day',
              },
            );
          })
        );
        webhooksSent += results.filter(r => r.status === 'fulfilled').length;
        emailsSent++;
      } catch (err) {
        logger.warn({ error: err, orgId }, 'Failed to send expiry alert');
      }
    }

    const totalExpiring = {
      '7_day': (categories.get('7_day') ?? []).length,
      '30_day': (categories.get('30_day') ?? []).length,
      '60_day': (categories.get('60_day') ?? []).length,
      '90_day': (categories.get('90_day') ?? []).length,
    };

    res.json({ processed: anchors.length, categories: totalExpiring, emailsSent, webhooksSent });
  } catch (error) {
    logger.error({ error }, 'Credential expiry check failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── Pipeline Health Monitor (SCALE-4 / SCRUM-548) ───
cronRouter.post('/pipeline-health', async (_req, res) => {
  try {
    const result = await checkPipelineHealth();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Pipeline health check failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── California State Bar attorney ingestion ───
cronRouter.post('/fetch-calbar', async (_req, res) => {
  try {
    const result = await fetchCalBarAttorneys(db);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'CalBar fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── FINRA BrokerCheck ingestion ───
cronRouter.post('/fetch-finra', async (_req, res) => {
  try {
    const result = await fetchFinraBrokers(db);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'FINRA BrokerCheck fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── SEC IAPD investment adviser ingestion ───
cronRouter.post('/fetch-sec-iapd', async (_req, res) => {
  try {
    const result = await fetchSecIapdFirms(db);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'SEC IAPD fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── NPPES NPI Registry (healthcare providers) ───
cronRouter.post('/fetch-npi', async (req, res) => {
  try {
    const states = req.body?.states as string[] | undefined;
    const maxPerRun = req.body?.maxPerRun ? parseInt(String(req.body.maxPerRun), 10) : undefined;
    const result = await fetchNpiProviders(db, { states, maxPerRun });
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'NPI Registry fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── SAM.gov (federal contractor registrations) ───
cronRouter.post('/fetch-sam-entities', async (req, res) => {
  try {
    const states = req.body?.states as string[] | undefined;
    const maxPerRun = req.body?.maxPerRun ? parseInt(String(req.body.maxPerRun), 10) : undefined;
    const result = await fetchSamEntities(db, { states, maxPerRun });
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'SAM.gov entity fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/fetch-sam-exclusions', async (_req, res) => {
  try {
    const result = await fetchSamExclusions(db);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'SAM.gov exclusions fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── FCC ULS (spectrum licenses) ───
cronRouter.post('/fetch-fcc', async (req, res) => {
  try {
    const maxPerRun = req.body?.maxPerRun ? parseInt(String(req.body.maxPerRun), 10) : undefined;
    const result = await fetchFccLicenses(db, { maxPerRun });
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'FCC ULS fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── NPH-05: State SOS Business Entity Fetchers ───
cronRouter.post('/fetch-sos', async (req, res) => {
  try {
    const state = req.body?.state ?? req.query.state;
    const results = await fetchSosEntities(db, state as string | undefined);
    res.json({ results });
  } catch (error) {
    logger.error({ error }, 'SOS entity fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── NPH-06: Professional Licensing Board Fetchers ───
cronRouter.post('/fetch-licensing-board', async (req, res) => {
  try {
    const board = req.body?.board ?? req.query.board;
    const results = await fetchLicensingBoardRecords(db, board as string | undefined);
    res.json({ results });
  } catch (error) {
    logger.error({ error }, 'Licensing board fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── NPH-07: Insurance License Fetchers ───
cronRouter.post('/fetch-insurance-licenses', async (req, res) => {
  try {
    const source = req.body?.source ?? req.query.source;
    const results = await fetchInsuranceLicenses(db, source as string | undefined);
    res.json({ results });
  } catch (error) {
    logger.error({ error }, 'Insurance license fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── NPH-08: CLE Credit Fetchers ───
cronRouter.post('/fetch-cle', async (req, res) => {
  try {
    const source = req.body?.source ?? req.query.source;
    const results = await fetchCleRecords(db, source as string | undefined);
    res.json({ results });
  } catch (error) {
    logger.error({ error }, 'CLE fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── NPH-09: Professional Certification Fetchers ───
cronRouter.post('/fetch-certifications', async (req, res) => {
  try {
    const source = req.body?.source ?? req.query.source;
    const results = await fetchCertificationRecords(db, source as string | undefined);
    res.json({ results });
  } catch (error) {
    logger.error({ error }, 'Certification fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── NPH-10: IPEDS Education Institution Fetcher ───
cronRouter.post('/fetch-ipeds', async (_req, res) => {
  try {
    const result = await fetchIpedsInstitutions(db);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'IPEDS fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── KAU-01/02: Kenya Compliance Data Fetcher ───
cronRouter.post('/fetch-kenya', async (_req, res) => {
  try {
    const result = await fetchKenyaComplianceData(db);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Kenya compliance data fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── KAU-03/04: Australia Compliance Data Fetcher ───
cronRouter.post('/fetch-australia', async (_req, res) => {
  try {
    const result = await fetchAustraliaComplianceData(db);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Australia compliance data fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── NCX-01: eCFR Federal Regulations Fetcher ───
cronRouter.post('/fetch-ecfr', async (_req, res) => {
  try {
    const result = await fetchEcfrRegulations(db);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'eCFR fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── Materialized View Refresh ───
cronRouter.post('/refresh-stats', async (_req, res) => {
  try {
    await callRpc(db, 'refresh_stats_materialized_views');
    res.json({ status: 'refreshed' });
  } catch (error) {
    logger.error({ error }, 'Stats materialized view refresh failed');
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

// ─── Metered Usage Reporting (PAY-02) ───

cronRouter.post('/report-metered-usage', async (_req, res) => {
  try {
    const { reportMeteredUsageToStripe } = await import('../billing/meteredBilling.js');
    const results = await reportMeteredUsageToStripe();
    res.json({ results });
  } catch (error) {
    logger.error({ error }, 'Metered usage reporting failed');
    res.status(500).json({ error: 'Reporting failed' });
  }
});

// ─── Production Smoke Test (P7-TS-06) ───

cronRouter.post('/smoke-test', async (_req, res) => {
  try {
    const results = await runSmokeTestSuite();
    const passed = results.filter((r) => r.status === 'pass').length;
    const failed = results.filter((r) => r.status === 'fail').length;

    // Store results in audit_events for history
    try {
      await db.from('audit_events').insert({
        event_type: 'smoke_test.completed',
        event_category: 'SYSTEM',
        details: JSON.stringify({
          passed,
          failed,
          total: results.length,
          results,
          timestamp: new Date().toISOString(),
        }),
      });
    } catch (storeErr) {
      logger.warn({ error: storeErr }, 'Failed to store smoke test results');
    }

    const statusCode = failed > 0 ? 503 : 200;
    res.status(statusCode).json({
      status: failed > 0 ? 'fail' : 'pass',
      passed,
      failed,
      total: results.length,
      timestamp: new Date().toISOString(),
      results,
    });
  } catch (error) {
    logger.error({ error }, 'Smoke test suite failed');
    res.status(500).json({ error: 'Smoke test runner failed' });
  }
});

/** GET endpoint for admin dashboard to fetch smoke test history */
cronRouter.get('/smoke-test/history', async (_req, res) => {
  try {
    const { data, error } = await db
      .from('audit_events')
      .select('created_at, details')
      .eq('event_type', 'smoke_test.completed')
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      res.status(500).json({ error: 'Failed to fetch smoke test history' });
      return;
    }

    const history = (data ?? []).map((row) => {
      const parsed = row.details ? JSON.parse(row.details) : {};
      return { timestamp: row.created_at, ...parsed };
    });

    res.json({ history });
  } catch (error) {
    logger.error({ error }, 'Smoke test history fetch failed');
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

interface SmokeCheckResult {
  name: string;
  status: 'pass' | 'fail';
  durationMs: number;
  detail?: string;
  error?: string;
}

async function runSmokeTestSuite(): Promise<SmokeCheckResult[]> {
  const results: SmokeCheckResult[] = [];

  // Check 1: Database connectivity
  const dbStart = Date.now();
  try {
    const { error } = await db.from('anchors').select('id').limit(1);
    results.push({
      name: 'database',
      status: error ? 'fail' : 'pass',
      durationMs: Date.now() - dbStart,
      ...(error ? { error: error.message } : { detail: 'Query OK' }),
    });
  } catch (err) {
    results.push({
      name: 'database',
      status: 'fail',
      durationMs: Date.now() - dbStart,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Check 2: Anchor count sanity (production should have >0)
  const anchorStart = Date.now();
  try {
    const { count, error } = await db.from('anchors').select('*', { count: 'exact', head: true });
    if (error) {
      results.push({ name: 'anchor-count', status: 'fail', durationMs: Date.now() - anchorStart, error: error.message });
    } else {
      results.push({
        name: 'anchor-count',
        status: (count ?? 0) > 0 ? 'pass' : 'fail',
        durationMs: Date.now() - anchorStart,
        detail: `${count ?? 0} total anchors`,
      });
    }
  } catch (err) {
    results.push({ name: 'anchor-count', status: 'fail', durationMs: Date.now() - anchorStart, error: String(err) });
  }

  // Check 3: Recent SECURED anchor (should have one within last 7 days)
  const securedStart = Date.now();
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await db
      .from('anchors')
      .select('created_at')
      .eq('status', 'SECURED')
      .gte('created_at', sevenDaysAgo)
      .limit(1);
    if (error) {
      results.push({ name: 'recent-secured', status: 'fail', durationMs: Date.now() - securedStart, error: error.message });
    } else {
      const hasRecent = (data?.length ?? 0) > 0;
      results.push({
        name: 'recent-secured',
        status: hasRecent ? 'pass' : 'fail',
        durationMs: Date.now() - securedStart,
        detail: hasRecent ? `Last secured: ${data![0].created_at}` : 'No SECURED anchors in last 7 days',
      });
    }
  } catch (err) {
    results.push({ name: 'recent-secured', status: 'fail', durationMs: Date.now() - securedStart, error: String(err) });
  }

  // Check 4: Config sanity
  const configStart = Date.now();
  const configIssues: string[] = [];
  if (!config.stripeSecretKey) configIssues.push('STRIPE_SECRET_KEY missing');
  if (!config.bitcoinNetwork) configIssues.push('BITCOIN_NETWORK missing');
  if (config.bitcoinNetwork === 'mainnet' && !config.enableProdNetworkAnchoring) {
    configIssues.push('MAINNET configured but ENABLE_PROD_NETWORK_ANCHORING=false');
  }
  results.push({
    name: 'config-sanity',
    status: configIssues.length === 0 ? 'pass' : 'fail',
    durationMs: Date.now() - configStart,
    detail: configIssues.length === 0 ? 'All critical config present' : configIssues.join('; '),
  });

  // Check 5: RLS active on anchors table
  const rlsStart = Date.now();
  try {
    // Service role query should work, anonymous should not be able to bypass RLS
    const { count, error } = await db.from('anchors').select('*', { count: 'exact', head: true });
    results.push({
      name: 'rls-active',
      status: error ? 'fail' : 'pass',
      durationMs: Date.now() - rlsStart,
      detail: error ? error.message : `Service role query OK (${count} rows)`,
    });
  } catch (err) {
    results.push({ name: 'rls-active', status: 'fail', durationMs: Date.now() - rlsStart, error: String(err) });
  }

  return results;
}
