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
import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { rateLimit } from '../utils/rateLimit.js';
import { db } from '../utils/db.js';
import { callRpc } from '../utils/rpc.js';
import { verifyAuthToken } from '../auth.js';
import { isPlatformAdmin } from '../utils/platformAdmin.js';
import { processPendingAnchors } from '../jobs/anchor.js';
import { checkSubmittedConfirmations } from '../jobs/check-confirmations.js';
import { runConfirmationProofBackfill } from '../jobs/confirmation-proof-backfill.js';
import { runBackCatalogClassifier, createDbGucReader, createDbLocker } from '../jobs/proof-backcatalog-classifier.js';
import {
  runProofMaterializer,
  createDbGucReader as createMaterializerGucReader,
  createDbLocker as createMaterializerLocker,
} from '../jobs/proof-materializer.js';
import { runDailyQueueDigest } from '../jobs/queue-digest-cron.js';
import { processRevokedAnchors } from '../jobs/revocation.js';
import { processWebhookRetries, dispatchWebhookEvent } from '../webhooks/delivery.js';
import { processMonthlyCredits } from '../jobs/credit-expiry.js';
import { processPendingReports } from '../jobs/report.js';
import { sweepExpiredAnchors, makeAnchorExpirySweepDb } from '../jobs/anchorExpirySweep.js';
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
import { processProfessionalEducationExtractionJobs } from '../jobs/professional-education-extraction.js';
import { fetchAcncCharities } from '../jobs/acncFetcher.js';
import { fetchStateBills, fetchMultipleStateBills } from '../jobs/openStatesFetcher.js';
import { fetchCalBarAttorneys } from '../jobs/calbarFetcher.js';
import { fetchFinraBrokers } from '../jobs/finraBrokerCheckFetcher.js';
import { fetchSecIapdFirms } from '../jobs/secIapdFetcher.js';
import { fetchEdgarFormAdv } from '../jobs/edgarFormAdvFetcher.js';
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
import { fetchEnforcementActions } from '../jobs/enforcementFetcher.js';
import { fetchContinuingEducationData } from '../jobs/ceFetcher.js';
import { fetchAcraSgCompanies } from '../jobs/singaporeFetcher.js';
import { fetchMohSgProviders } from '../jobs/singaporeHealthFetcher.js';
import { fetchCmsPhysicians, fetchStateMedicalBoards } from '../jobs/cmsPhysicianFetcher.js';
import { fetchBrazilComplianceData, fetchSingaporeComplianceData, fetchMexicoComplianceData } from '../jobs/intlComplianceFetcher.js';
import { fetchCnpjBrCompanies } from '../jobs/brazilFetcher.js';
import { detectReorgs, monitorStuckTransactions, rebroadcastDroppedTransactions, consolidateUtxos, monitorFeeRates } from '../jobs/chain-maintenance.js';
import { runRegulatoryChangeScan } from '../jobs/regulatory-change-scan.js';
import { runCalibrationRefit } from '../jobs/calibration-refit.js';
import { withCronMonitoring } from '../utils/sentry.js';
import {
  isProfessionalEducationSchemaReady,
  professionalEducationSchemaUnavailableBody,
} from '../utils/professionalEducationSchemaGate.js';
import { recoverStuckBroadcasts } from '../jobs/broadcast-recovery.js';
import { refreshTreasuryCache } from '../jobs/treasury-cache.js';
import { runTreasuryAlertCheck } from '../jobs/treasury-alert.js';
import { buildTreasuryAlertDispatcher } from '../jobs/treasury-alert-dispatcher.js';
import { runQueueReminderJob } from '../jobs/queue-reminders.js';
import { runOrgQueueScheduler } from '../jobs/org-queue-scheduler.js';
import { runConnectorArtifactDrain } from '../jobs/connector-artifact-drain.js';
import { runRulesEngine } from '../jobs/rules-engine.js';
import { runRuleActionDispatcher } from '../jobs/rule-action-dispatcher.js';
import { runDocusignEnvelopeCompletedJobs } from '../jobs/docusign-envelope-completed.js';
import { runDocusignNotarizationCompletedJobs } from '../jobs/docusign-notarization-completed.js';
import { runDriveFileChangedJobs } from '../jobs/drive-file-changed.js';
import { runDbHealthMonitor } from '../jobs/db-health-monitor.js';
import { runSubscriptionRenewal } from '../jobs/workspace-subscription-renewal.js';
import { runMainnetMigration, getMigrationStatus } from '../jobs/mainnet-migration.js';
import { checkPipelineHealth } from '../jobs/pipeline-health.js';
import { runConnectorHealthCheck } from '../jobs/connector-health-alert.js';
import { runCeKeyExpiryCheck } from '../jobs/ce-key-expiry-alert.js';
import { runCeRegistryDriftCheck } from '../jobs/ce-registry-drift.js';
import { runStuckAnchorCheck } from '../jobs/stuck-anchor-monitor.js';
import {
  runPipelineThroughputMonitor,
  DEFAULT_THROUGHPUT_WINDOW_HOURS,
  DEFAULT_LINKER_STALL_THRESHOLD_HOURS,
} from '../jobs/pipelineThroughputMonitor.js';
import { runCreditConservationReconciler } from '../jobs/credit-conservation-reconciler.js';
import { GRACE_EXPIRY_SWEEP_CRON, runGraceExpirySweep } from '../jobs/grace-expiry-sweep.js';
import { sweepExpiredNonces, makeNonceSweepDb } from '../jobs/nonce-sweep.js';
import { reconcileDocusignGaps } from '../jobs/docusign-reconciliation.js';
import { makeReconciliationDeps } from '../jobs/docusign-reconciliation-deps.js';
import { renewDriveSubscriptions } from '../integrations/connectors/drive-subscription-renewal.js';
import {
  makeDriveSubscriptionRenewalDb,
  makeDriveSubscriptionRenewalClient,
  alertDriveSubscriptionRenewal,
} from '../jobs/drive-subscription-renewal-deps.js';
import { reconcileDocusignQueueDrift } from '../jobs/docusign-queue-reconciliation.js';
import { makeQueueReconciliationDeps } from '../jobs/docusign-queue-reconciliation-deps.js';
import { pollDocusignConnectFailures } from '../jobs/docusign-connect-failures.js';
import { makeConnectFailuresDeps } from '../jobs/docusign-connect-failures-deps.js';
import { reconcileListenerDrift } from '../jobs/docusign-listener-drift.js';
import { makeListenerDriftDeps } from '../jobs/docusign-listener-drift-deps.js';
import { MONTHLY_ALLOCATION_ROLLOVER_CRON, runAllocationRollover } from '../jobs/monthly-allocation-rollover.js';
import { runStripeAnchorReconciliation, generateFinancialReport, processFailedPaymentRecovery } from '../billing/reconciliation.js';
import { logHeapStatus } from '../utils/heapMonitor.js';
import { getBuildSha, isValidBuildSha } from '../utils/buildInfo.js';

export const cronRouter = Router();

// CORS for browser-based admin triggers (PipelineAdminPage)
import { corsMiddleware } from './middleware.js';

const DocusignEnvelopeCompletedLimitSchema = z.coerce.number().int().min(1).max(100);
const DriveFileChangedLimitSchema = z.coerce.number().int().min(1).max(100);

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

cronRouter.post('/batch-anchors', async (req, res) => {
  try {
    // ?force=true bypasses the size/age trigger (daily 3am EST sweep).
    const force = req.query.force === 'true' || req.query.force === '1';
    const rawOrgId = req.query.org_id ?? req.body?.org_id;
    let orgId: string | undefined;
    if (rawOrgId !== undefined) {
      if (typeof rawOrgId !== 'string') {
        res.status(400).json({ error: 'Invalid org_id' });
        return;
      }
      orgId = rawOrgId.trim();
      const parsedOrgId = z.string().uuid().safeParse(orgId);
      if (!parsedOrgId.success) {
        res.status(400).json({ error: 'Invalid org_id' });
        return;
      }
      orgId = parsedOrgId.data;
    }
    const result = await processBatchAnchors({ force, orgId });
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Batch anchor processing failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/professional-education-extraction', async (req, res) => {
  try {
    if (!isProfessionalEducationSchemaReady()) {
      res.status(503).json(professionalEducationSchemaUnavailableBody('cron:professional-education-extraction'));
      return;
    }

    const maxJobs = req.body?.maxJobs
      ? Math.min(Math.max(Number.parseInt(String(req.body.maxJobs), 10) || 10, 1), 100)
      : 10;
    const result = await processProfessionalEducationExtractionJobs(maxJobs);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Professional education extraction processing failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/check-confirmations', async (_req, res) => {
  try {
    const result = await withCronMonitoring(
      'check-confirmations',
      '*/30 * * * *',
      () => checkSubmittedConfirmations(),
    )();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Confirmation check failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// PROOF-03 (SCRUM-2336): confirmation-proof backfill.
//
// PRODUCTION TRIGGER. The real-network soak proved the in-process node-cron
// schedule (routes/scheduled.ts) NEVER fires on Cloud Run — node-cron is
// dormant while CPU is throttled between requests. Prod drives cron via Cloud
// Scheduler → HTTP, so the backfill needs this endpoint to run at all. The
// in-process schedule stays as the dev/test backup. `runConfirmationProofBackfill`
// already no-ops (skipped:true) in mock mode / when prod anchoring is off, and
// needs no mutex (idempotent — the populated block_header is the watermark and
// the last writer writes identical bytes). Same cronAuth + JSON-result /
// 500-on-error shape as /check-confirmations.
cronRouter.post('/populate-confirmation-proofs', async (_req, res) => {
  try {
    const result = await runConfirmationProofBackfill();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Confirmation-proof backfill failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// S3-A (PROOF-BACKCATALOG): back-catalogue proof-completeness CLASSIFIER.
//
// MANUAL TRIGGER ONLY — deliberately NOT scheduled (no Cloud Scheduler
// binding, no in-process backup): the census is an operator-driven run, and
// any future write mode is Carson-gated. Follows the Cloud Scheduler → HTTP
// pattern anyway (node-cron is dormant under Cloud Run CPU throttling, so an
// authenticated POST is the only trigger that actually fires in prod).
//
// DRY-RUN BY DEFAULT: emits the per-class plan {direct_anchored,
// batch_provable, already_complete, ambiguous} with zero writes to the proof
// catalogue (anchors/anchor_proofs); the resumable census still persists its
// own durable job_queue checkpoint row in both modes. Write mode needs
// execute=true AND PROOF_CLASSIFIER_CONFIRM=EXECUTE, halts when ambiguous > 0,
// refuses while the 0340 GUC is on (or unconfirmable), and persists exactly the
// one 0354 class column via the resumable label-apply pass (the pre-0354
// schema-gap refusal is retained as a generic fail-honest guard).
// Resumable via a durable job_queue checkpoint — re-POST to continue a long
// census; restart=true starts a fresh one.
// F1 CONCURRENCY GUARD: createDbLocker gives the run a (scope,mode)-keyed
// pg_try_advisory_lock so two concurrent POSTs can't interleave their
// read-modify-write of the ONE checkpoint row (which would rewind the cursor +
// silently corrupt the plan). The second concurrent run returns
// refused/lock_not_acquired; the lock releases in a finally on every path.
// Zod boundary validation (§1.1: every write path — the classifier persists a
// job_queue checkpoint row even in dry-run). Booleans accept JSON booleans or
// the query-string forms; numbers are coerced and BOUNDED here so a mistyped
// value fails loudly with a 400 instead of being silently coerced/defaulted.
// Bounds mirror the classifier's own clamps (batch 50–2000, batches 1–200).
const ClassifierBooleanishSchema = z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])]);
const ClassifyProofBackcatalogParamsSchema = z.object({
  execute: ClassifierBooleanishSchema.optional(),
  batch_size: z.coerce.number().int().min(50).max(2000).optional(),
  max_batches: z.coerce.number().int().min(1).max(200).optional(),
  restart: ClassifierBooleanishSchema.optional(),
});

/** Boolean-ish query/body flag → strict boolean (shared by both proof routes). */
const proofRouteFlag = (v: boolean | 'true' | 'false' | '1' | '0' | undefined) =>
  v === true || v === 'true' || v === '1';

/**
 * Shared boundary parse for the two proof back-catalogue routes (classifier +
 * SCRUM-2917 materializer). They deliberately share ONE schema — the bounds are
 * a single source of truth — so the org_id validation and 400 envelope live
 * here once. `errorLabel` keeps each route's 400 body text distinct.
 */
function parseProofBackcatalogParams(
  req: Request,
  errorLabel: string,
):
  | {
      ok: true;
      orgId: string | undefined;
      execute: boolean;
      batchSize: number | undefined;
      maxBatches: number | undefined;
      restart: boolean;
    }
  | { ok: false; status: number; body: Record<string, unknown> } {
  const rawOrgId = req.query.org_id ?? req.body?.org_id;
  let orgId: string | undefined;
  if (rawOrgId !== undefined) {
    const parsedOrgId = z.string().uuid().safeParse(String(rawOrgId).trim());
    if (!parsedOrgId.success) {
      return { ok: false, status: 400, body: { error: 'Invalid org_id' } };
    }
    orgId = parsedOrgId.data;
  }

  const parsedParams = ClassifyProofBackcatalogParamsSchema.safeParse({
    execute: req.query.execute ?? req.body?.execute,
    batch_size: req.query.batch_size ?? req.body?.batch_size,
    max_batches: req.query.max_batches ?? req.body?.max_batches,
    restart: req.query.restart ?? req.body?.restart,
  });
  if (!parsedParams.success) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `Invalid ${errorLabel} parameters`,
        details: parsedParams.error.flatten().fieldErrors,
      },
    };
  }
  return {
    ok: true,
    orgId,
    execute: proofRouteFlag(parsedParams.data.execute),
    batchSize: parsedParams.data.batch_size,
    maxBatches: parsedParams.data.max_batches,
    restart: proofRouteFlag(parsedParams.data.restart),
  };
}

cronRouter.post('/classify-proof-backcatalog', async (req, res) => {
  try {
    const params = parseProofBackcatalogParams(req, 'classifier');
    if (!params.ok) {
      res.status(params.status).json(params.body);
      return;
    }

    const result = await runBackCatalogClassifier(
      {
        client: db,
        guc: createDbGucReader(db),
        locker: createDbLocker(db),
        logger,
        confirmToken: config.proofClassifierConfirm,
      },
      {
        execute: params.execute,
        orgId: params.orgId,
        batchSize: params.batchSize,
        maxBatches: params.maxBatches,
        restart: params.restart,
      },
    );
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Back-catalogue proof classifier failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// SCRUM-2917: insert-capable direct-anchor proof MATERIALIZER.
//
// MANUAL TRIGGER ONLY — deliberately NOT scheduled (no Cloud Scheduler
// binding, no in-process backup): populating the ~2.96M-anchor back catalogue
// is an operator-driven, Carson-gated T3 run. Same authenticated-POST pattern
// as /classify-proof-backcatalog above.
//
// DRY-RUN BY DEFAULT: plans the honest direct-anchor skeleton INSERT set
// (anchor_id, receipt_id := chain_tx_id, proof_completeness_class =
// 'direct_anchored', materialize_run_id) with ZERO writes to anchor_proofs.
// Write mode needs execute=true AND PROOF_MATERIALIZER_CONFIRM=EXECUTE (dual
// guard inside the job), halts on any ambiguous row BEFORE writing its page,
// refuses while the 0340/0360 GUC is on (or unconfirmable in write mode), and
// is idempotent via ON CONFLICT (anchor_id) DO NOTHING. It NEVER fabricates
// merkle_root / proof_path / op_return_payload — direct anchors keep those
// EMPTY (honest); the CTO-ruled 0360 predicate means these skeletons do NOT
// satisfy the SECURED gate until the SCRUM-2491 backfill fills op_return.
// Resumable via a durable job_queue checkpoint; one runId per census is the
// per-run rollback key (0359 materialize_run_id column).
// Zod boundary + advisory-locker wiring mirror the classifier route exactly.
cronRouter.post('/materialize-proof-backcatalog', async (req, res) => {
  try {
    const params = parseProofBackcatalogParams(req, 'materializer');
    if (!params.ok) {
      res.status(params.status).json(params.body);
      return;
    }

    const result = await runProofMaterializer(
      {
        client: db,
        guc: createMaterializerGucReader(db),
        locker: createMaterializerLocker(db),
        logger,
        confirmToken: config.proofMaterializerConfirm,
      },
      {
        execute: params.execute,
        orgId: params.orgId,
        batchSize: params.batchSize,
        maxBatches: params.maxBatches,
        restart: params.restart,
      },
    );
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Proof materializer failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// QUEUE-07 (SCRUM-2353): daily review digest to org admins.
//
// PRODUCTION TRIGGER (Cloud Scheduler → HTTP; node-cron is dormant under Cloud
// Run CPU throttling). One row per org admin, scoped to the admin's org + owned
// sub-orgs. Counts-only — never document content (§1.6). Idempotent per
// (admin, org, UTC date) via the audit-events-backed delivery log, so a daily
// re-trigger or Scheduler retry does not double-send. Gated by
// ENABLE_QUEUE_DIGEST (no-op when 'false').
cronRouter.post('/queue-digest', async (_req, res) => {
  try {
    const result = await withCronMonitoring(
      'queue-digest',
      '0 13 * * *',
      () => runDailyQueueDigest(),
    )();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Daily queue digest failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/process-revocations', async (_req, res) => {
  try {
    const result = await withCronMonitoring(
      'process-revocations',
      '*/5 * * * *',
      () => processRevokedAnchors(),
    )();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Revocation processing failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/webhook-retries', async (_req, res) => {
  try {
    const retried = await withCronMonitoring(
      'webhook-retries',
      '*/10 * * * *',
      () => processWebhookRetries(),
    )();
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

// Cloud Scheduler job `generate-reports` (hourly, `0 * * * *`) has targeted
// this path since MVP-28 (2026-03-16), but the route registration was never
// added when jobs/report.ts's processPendingReports() was written — every
// scheduled run 404'd. Drains `reports` rows in status='pending' (created via
// the legacy ReportsList "Generate Report" action) and materializes the
// artifact into `report_artifacts`.
cronRouter.post('/generate-reports', async (_req, res) => {
  try {
    const result = await processPendingReports();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Report generation failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// S1-9 (SCRUM-2349 / PM-25): money-conservation reconciler. Fires the prod
// `org_credit_ledger_divergence` SQL function over ALL orgs (read-only),
// builds a conservation report, and pages (error log + Sentry) on any drift.
// Cloud Scheduler triggers daily; in-process backup wired in scheduled.ts.
// HTTP semantics mirror /check-stuck-anchors: a DETECTED divergence
// (healthy:false from a successful read) is a CORRECT result → 200 (we do not
// want Scheduler retrying a true "ledger diverged" finding). Only a probe
// FAILURE (RPC error / throw → result.error set) returns 500 so Scheduler
// retries the broken probe. The reconciler never throws — it returns a
// structured result — so we branch on result.error rather than try/catch.
cronRouter.post('/reconcile-credit-conservation', async (_req, res) => {
  const result = await runCreditConservationReconciler(db);
  if (result.error) {
    res.status(500).json(result);
    return;
  }
  res.json(result);
});

// SCRUM-1736: anchor expiry sweep — transitions SECURED anchors past
// `expires_at` to EXPIRED and dispatches anchor.expired webhook
// (schema: services/worker/src/webhooks/payload-schemas.ts → SCRUM-1735).
// Cloud Scheduler triggers daily; in-process backup wired in scheduled.ts.
cronRouter.post('/anchor-expiry-sweep', async (_req, res) => {
  try {
    const adapter = makeAnchorExpirySweepDb({ db, dispatchWebhookEvent });
    const result = await sweepExpiredAnchors(adapter);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Anchor expiry sweep failed');
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

// ─── ARK-103 (SCRUM-1013): Treasury Low-Balance Alert ───
cronRouter.post('/treasury-alert-check', async (_req, res) => {
  try {
    const decision = await runTreasuryAlertCheck(buildTreasuryAlertDispatcher());
    res.json({
      fired: decision.should_fire,
      reason: decision.reason,
      below_threshold: decision.below_threshold,
      price_unknown: decision.price_unknown,
    });
  } catch (error) {
    logger.error({ error }, 'Treasury alert check failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── SCRUM-2902: Credential Engine API key expiry alarm (fail-LOUD) ───
// Daily Cloud Scheduler tick. Emits escalating Sentry events at T-30/T-14/T-7
// and continuously after expiry; fails LOUD (fires every run) when
// CE_API_KEY_EXPIRES_AT is unset/sentinel. The Sentry event only pages a human
// via the "SCRUM-2902 — Credential Engine API key expiry" rule in
// infra/sentry/alert-rules.json (→ Slack #ops) — event ≠ alert.
cronRouter.post('/ce-key-expiry-check', async (_req, res) => {
  try {
    const result = runCeKeyExpiryCheck();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'CE key expiry check failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── CE Registry drift reconciliation (read-only read-back) ───
// Re-reads every anchored CE Registry CTID from the PUBLIC registry, re-hashes
// the bytes, and records a finding wherever the registry's current content no
// longer matches what we anchored. Read-only: it publishes NOTHING to
// Credential Engine. Gated by ENABLE_CE_REGISTRY_DRIFT_CHECK (default FALSE) —
// with the flag off this route returns `skipped:true` and makes no outbound
// request, so the surface is dark until deliberately enabled. No Cloud
// Scheduler job is created by this PR; standing it up is a separate,
// intentional ops step.
cronRouter.post('/ce-registry-drift-check', async (req, res) => {
  try {
    const rawLimit = req.query.limit ?? req.body?.limit;
    const parsedLimit = rawLimit === undefined ? undefined : Number.parseInt(String(rawLimit), 10);
    const result = await runCeRegistryDriftCheck({
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    });
    // A load failure reconciled NOTHING. Answering 200 would hand Cloud
    // Scheduler a success for a pass that did no work — the job carries a
    // `loadFailed` field precisely so this is distinguishable, and burying it in
    // a 200 body throws that distinction away at the only layer that acts on it.
    // 500 so Scheduler retries.
    res.status(result.loadFailed ? 500 : 200).json(result);
  } catch (error) {
    logger.error({ error }, 'CE registry drift check failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── ARK-107 (SCRUM-1019): Scheduled Queue Review Reminders ───
cronRouter.post('/queue-reminders', async (_req, res) => {
  try {
    const result = await runQueueReminderJob();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Queue reminder job failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── SCRUM-1130: Durable 24-hour Organization Queue Scheduler ───
cronRouter.post('/org-queue-scheduler', async (req, res) => {
  try {
    const rawLimit = req.query.limit ?? req.body?.limit;
    const parsedLimit = rawLimit === undefined ? undefined : Number.parseInt(String(rawLimit), 10);
    const result = await runOrgQueueScheduler({
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    });
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Org queue scheduler pass failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── QUEUE-06 (SCRUM-2352): connector_artifact drain consumer ───
//
// PRODUCTION TRIGGER. Cloud Scheduler hits this HTTP endpoint because in-process
// node-cron is dormant under Cloud Run CPU throttling (the PROOF-03 soak proved
// the dev/test backup never fires in prod). `runConnectorArtifactDrain` no-ops
// (`skipped:true`) when ENABLE_CONNECTOR_ARTIFACT_DRAIN is false, drains each org
// with at least one pending|queued row, and charges credits ONLY at SECURING via
// debit_and_enqueue_anchor. Idempotent (compare-and-set claim) → no mutex needed.
cronRouter.post('/drain-connector-artifacts', async (_req, res) => {
  try {
    const result = await runConnectorArtifactDrain();
    // The drain isolates per-org failures (one org throwing keeps the others
    // draining), so `orgsFailed > 0` is a PARTIAL failure that a green 200 would
    // hide from Cloud Scheduler. Drain the other orgs first, then respond non-2xx
    // so Scheduler RETRIES the pass. The drain is idempotent (compare-and-set
    // claim + anchor-id-keyed debit), so a retry re-drives only the stuck orgs —
    // already-anchored rows are skipped. Still return the aggregate body for
    // observability.
    if (result.orgsFailed > 0) {
      logger.warn({ result }, 'Connector-artifact drain had per-org failures; responding 500 for Scheduler retry');
      res.status(500).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    // Scrub: log only the bounded error message/string, never the full thrown
    // object, on this connector-artifact path (§1.6A — an upstream failure must
    // not leak connector payload fields into logs).
    const err = error instanceof Error ? error.message : String(error);
    logger.error({ err }, 'Connector-artifact drain pass failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── ARK-106 (SCRUM-1018): Rules Engine Execution Pass ───
cronRouter.post('/rules-engine', async (_req, res) => {
  try {
    const result = await runRulesEngine();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Rules engine pass failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── SCRUM-1142: Rule Action Dispatcher MVP ───
cronRouter.post('/rule-action-dispatcher', async (_req, res) => {
  try {
    const result = await runRuleActionDispatcher();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Rule action dispatcher pass failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── SCRUM-1101/SCRUM-1718: DocuSign completed-envelope document fetch jobs ───
cronRouter.post('/docusign-envelope-completed', async (req, res) => {
  try {
    const rawLimit = req.query.limit ?? req.body?.limit;
    const parsedLimit = rawLimit === undefined
      ? undefined
      : DocusignEnvelopeCompletedLimitSchema.safeParse(rawLimit);
    if (parsedLimit && !parsedLimit.success) {
      res.status(400).json({ error: 'Invalid request', details: parsedLimit.error.flatten() });
      return;
    }
    const result = await runDocusignEnvelopeCompletedJobs({
      limit: parsedLimit?.data,
    });
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'DocuSign completed-envelope queue pass failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── SCRUM-2903 (GD-PROD): Google Drive file-changed job queue ───
//
// Drive twin of /docusign-envelope-completed above. PRODUCTION TRIGGER —
// Cloud Scheduler hits this HTTP endpoint (in-process node-cron is the
// dev/test backup in routes/scheduled.ts; it's dormant under Cloud Run CPU
// throttling per the PROOF-03 finding). Drains the `google_drive.file_changed`
// job_queue type that drive-changes-runner.ts writes on a matched change:
// fetch bytes -> SHA-256 in memory -> discard -> enqueue_connector_artifact
// (§1.6A). `runDriveFileChangedJobs` no-ops the hash/enqueue step (returns
// the disabled sentinel per job) when ENABLE_CONNECTOR_ARTIFACT_ENQUEUE is
// false, so hitting this route is safe with the flag off.
cronRouter.post('/drive-file-changed', async (req, res) => {
  try {
    const rawLimit = req.query.limit ?? req.body?.limit;
    const parsedLimit = rawLimit === undefined
      ? undefined
      : DriveFileChangedLimitSchema.safeParse(rawLimit);
    if (parsedLimit && !parsedLimit.success) {
      res.status(400).json({ error: 'Invalid request', details: parsedLimit.error.flatten() });
      return;
    }
    const result = await runDriveFileChangedJobs({
      limit: parsedLimit?.data,
    });
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Drive file-changed queue pass failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── SCRUM-1872: DocuSign notarization completed job queue ───
cronRouter.post('/docusign-notarization-completed', async (req, res) => {
  try {
    const rawLimit = req.query.limit ?? req.body?.limit;
    const parsedLimit = rawLimit === undefined
      ? undefined
      : DocusignEnvelopeCompletedLimitSchema.safeParse(rawLimit);
    if (parsedLimit && !parsedLimit.success) {
      res.status(400).json({ error: 'Invalid request', details: parsedLimit.error.flatten() });
      return;
    }
    const result = await runDocusignNotarizationCompletedJobs({
      limit: parsedLimit?.data,
    });
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'DocuSign notarization-completed queue pass failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── SCRUM-1147: Drive/Graph subscription renewal sweep ───
// Vendor renewal calls are stubbed pending live OAuth wiring; production
// rollout swaps these for real Google Drive channels.watch + MS Graph
// subscriptions.update calls.
cronRouter.post('/workspace-subscription-renewal', async (_req, res) => {
  try {
    const result = await runSubscriptionRenewal({
      driveRenew: async () => {
        throw new Error('drive renewal not configured — set GOOGLE_DRIVE_RENEWAL_ENDPOINT');
      },
      graphRenew: async () => {
        throw new Error('graph renewal not configured — set MICROSOFT_GRAPH_RENEWAL_ENDPOINT');
      },
    });
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Workspace subscription renewal pass failed');
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
    const result = await withCronMonitoring(
      'fetch-uspto',
      '*/15 * * * *',
      () => fetchUsptoPAtents(db),
    )();
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

cronRouter.post('/grace-expiry-sweep', async (_req, res) => {
  try {
    const result = await withCronMonitoring(
      'grace-expiry-sweep',
      GRACE_EXPIRY_SWEEP_CRON,
      () => runGraceExpirySweep(),
    )();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Payment grace expiry sweep failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/monthly-allocation-rollover', async (_req, res) => {
  try {
    const result = await withCronMonitoring(
      'monthly-allocation-rollover',
      MONTHLY_ALLOCATION_ROLLOVER_CRON,
      () => runAllocationRollover(),
    )();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Monthly allocation rollover failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

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

// ─── SEC EDGAR Form ADV (investment adviser — IAPD WAF workaround, SCRUM-727) ───
cronRouter.post('/fetch-edgar-form-adv', async (req, res) => {
  try {
    const maxRecords = req.body?.maxRecords ? parseInt(String(req.body.maxRecords), 10) : undefined;
    const result = await fetchEdgarFormAdv(db, { maxRecords });
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'EDGAR Form ADV fetch failed');
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

// ─── CMS Physician Compare (Medicare providers — NPH-11) ───
cronRouter.post('/fetch-cms-physicians', async (req, res) => {
  try {
    const states = req.body?.states as string[] | undefined;
    const maxPerRun = req.body?.maxPerRun ? parseInt(String(req.body.maxPerRun), 10) : undefined;
    const result = await fetchCmsPhysicians(db, { states, maxPerRun });
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'CMS Physician Compare fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── State Medical Boards (physician licenses — NPH-11) ───
cronRouter.post('/fetch-medical-boards', async (req, res) => {
  try {
    const states = req.body?.states as string[] | undefined;
    const maxPerRun = req.body?.maxPerRun ? parseInt(String(req.body.maxPerRun), 10) : undefined;
    const result = await fetchStateMedicalBoards(db, { states, maxPerRun });
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'State Medical Board fetch failed');
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

// ─── INTL-01: Brazil LGPD compliance data ───
cronRouter.post('/fetch-brazil-compliance', async (_req, res) => {
  try {
    const result = await fetchBrazilComplianceData(db);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Brazil compliance data fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── INTL-02: Singapore PDPA compliance data ───
cronRouter.post('/fetch-singapore-compliance', async (_req, res) => {
  try {
    const result = await fetchSingaporeComplianceData(db);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Singapore compliance data fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── INTL-03: Mexico LFPDPPP compliance data ───
cronRouter.post('/fetch-mexico-compliance', async (_req, res) => {
  try {
    const result = await fetchMexicoComplianceData(db);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Mexico compliance data fetch failed');
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

// ─── NCX-02: Enforcement Actions Fetcher ───
cronRouter.post('/fetch-enforcement', async (_req, res) => {
  try {
    const result = await fetchEnforcementActions(db);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Enforcement action fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── NCX-03/04: Continuing Education (NASBA + ACCME) ───
cronRouter.post('/fetch-continuing-education', async (_req, res) => {
  try {
    const result = await fetchContinuingEducationData(db);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Continuing education fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── International: Singapore (ACRA + MOH) ───

cronRouter.post('/fetch-acra-sg', async (_req, res) => {
  try {
    const result = await fetchAcraSgCompanies(db);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'ACRA SG fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

cronRouter.post('/fetch-moh-sg', async (_req, res) => {
  try {
    const result = await fetchMohSgProviders(db);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'MOH SG fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── International: Brazil (CNPJ) ───

cronRouter.post('/fetch-cnpj-br', async (req, res) => {
  try {
    const customCnpjs = req.body?.cnpjs as string[] | undefined;
    const result = await fetchCnpjBrCompanies(db, customCnpjs);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'CNPJ BR fetch failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── Regulatory Change Scan (NCA-FU1 #1) ───

cronRouter.post('/regulatory-change-scan', async (_req, res) => {
  try {
    const result = await withCronMonitoring(
      'regulatory-change-scan',
      '0 */6 * * *',
      () => runRegulatoryChangeScan(),
    )();
    res.json({
      scanned: result.scanned,
      alerts_created: result.alertsCreated,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({ error }, 'Regulatory change scan failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── Pipeline dashboard cache refresh ───
//
// 2026-04-28 hotfix: this endpoint previously called only
// `refresh_stats_materialized_views`, which refreshed two materialized
// views nothing reads (`mv_anchor_status_counts`,
// `mv_public_records_source_counts`). The actual dashboard reads from
// the `pipeline_dashboard_cache` table populated by the
// `refresh_cache_*` sub-refreshers — which nothing was calling.
//
// 2026-07-20 rework (refresh-stats 500s since the 07-17 drain resume):
// driving the six sub-refreshers through the monolithic
// `refresh_pipeline_dashboard_cache()` wrapper put them all inside ONE
// top-level statement. `SET statement_timeout` inside an already-running
// statement arms against the OUTER statement's start (see migration 0335),
// so under drain load the wrapper ran effectively unbudgeted, outran the
// Supabase API gateway (~120s → "upstream request timeout"), and the
// legacy `refresh_stats_materialized_views()` leg died at the 60s session
// statement_timeout — both legs failed → 500 on ~30% of cron firings.
//
// Now each sub-refresher runs as its OWN top-level RPC call, where its
// function-level `SET statement_timeout` genuinely bounds it (verified
// live 2026-07-20: 0.2–20.4s each, worst-case sum ≈ 61s — well under the
// gateway cut). A slow or failed key degrades that key only; 500 (which
// makes Cloud Scheduler retry) is reserved for ALL six failing. The legacy
// mat-view call is gone: its two matviews have zero readers, and a
// follow-up migration can drop them plus `refresh_stats_materialized_views`
// and the now-unused `refresh_pipeline_dashboard_cache` wrapper.
//
// Concurrency: the old wrapper held pg_try_advisory_lock. Each
// sub-refresher is an idempotent single-row upsert, so overlapping runs
// are harmless (last write wins); with a 5-min cron and ≤~60s worst-case
// runtime, overlap is rare.
const DASHBOARD_CACHE_REFRESHERS = [
  { key: 'pipeline_stats', rpc: 'refresh_cache_pipeline_stats' },
  { key: 'anchor_status_counts', rpc: 'refresh_cache_anchor_status_counts' },
  { key: 'by_source', rpc: 'refresh_cache_by_source' },
  { key: 'anchor_type_counts', rpc: 'refresh_cache_anchor_type_counts' },
  { key: 'record_types', rpc: 'refresh_cache_record_types' },
  { key: 'anchor_tx_stats', rpc: 'refresh_cache_anchor_tx_stats' },
] as const;

cronRouter.post('/refresh-stats', async (_req, res) => {
  const startedAt = Date.now();
  const refreshed: string[] = [];
  const errors: Array<{ source: string; message: string }> = [];

  for (const { key, rpc } of DASHBOARD_CACHE_REFRESHERS) {
    try {
      const result = await callRpc(db, rpc);
      if (result.error) throw new Error(result.error.message);
      refreshed.push(key);
    } catch (error) {
      logger.error({ error, rpc }, `Dashboard cache refresher ${key} failed`);
      errors.push({
        source: key,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const duration_ms = Date.now() - startedAt;

  if (refreshed.length === 0) {
    // Nothing refreshed at all — surface 500 so Cloud Scheduler retries.
    res.status(500).json({
      status: 'failed',
      reason: 'all refresh paths failed',
      refreshed,
      succeeded: 0,
      duration_ms,
      errors,
    });
    return;
  }

  res.json({
    status: errors.length > 0 ? 'partial' : 'refreshed',
    refreshed,
    succeeded: refreshed.length,
    duration_ms,
    errors,
  });
});

// ─── Calibration Refit (GME7.3 — SCRUM-856) ───

cronRouter.post('/calibration-refit', async (_req, res) => {
  try {
    const result = await withCronMonitoring(
      'calibration-refit',
      '0 3 * * 1',
      () => runCalibrationRefit(),
    )();
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Calibration refit failed');
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

// ─── SCRUM-2040: Webhook nonce sweep (SOC 2 CC7.4) ───
cronRouter.post('/nonce-sweep', async (_req, res) => {
  try {
    const adapter = makeNonceSweepDb(db);
    const result = await sweepExpiredNonces(adapter);
    if (!result.ok) {
      res.status(500).json({
        ...result,
        message: `Partial failure: ${result.errors.length} of ${Object.keys(result.swept).length} tables failed`,
      });
      return;
    }
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Nonce sweep failed');
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

// ─── DB Health Monitor (SCRUM-1254 / R0-8) ───
//
// Cloud Scheduler hits this every 5 minutes. Emits Sentry events on
// pg_cron failures, dead-tuple bloat, and smoke fail-streaks. See
// services/worker/src/jobs/db-health-monitor.ts for the alert thresholds.
//
// Code-review issue #O (PR #563): wrapped in `withCronMonitoring` so
// Sentry Crons receives in-progress / ok / error check-ins. Without this,
// a stalled monitor would itself be undetected — the very class of
// failure R0-8 was meant to surface.

cronRouter.post('/db-health', async (_req, res) => {
  const monitor = withCronMonitoring('db-health-monitor', '*/5 * * * *', async () => {
    return runDbHealthMonitor();
  });
  try {
    const snapshot = await monitor();
    res.json({
      ok: snapshot.alerts.length === 0,
      alertCount: snapshot.alerts.length,
      snapshot,
    });
  } catch (error) {
    logger.error({ error }, 'db-health-monitor failed');
    res.status(500).json({ error: 'db-health-monitor failed' });
  }
});

// ─── SCRUM-2041: Connector health check (SOC 2 CC7.1) ───
cronRouter.post('/connector-health-check', async (_req, res) => {
  try {
    const result = await runConnectorHealthCheck(db);
    if (!result.ok) {
      res.status(500).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Connector health check failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── SCRUM-2234: Stuck anchor monitor (2026-06-01 incident) ───
//
// Detects a stalled anchoring pipeline by the age of the oldest non-deleted
// PENDING anchor. The daily-anchor-flush 401 blackout went undetected for ~6
// weeks because nothing alerted on the queue not draining; this closes that
// gap with an error-level log + Sentry page when the oldest PENDING anchor
// exceeds STUCK_ANCHOR_ALERT_HOURS (default 24h). Cloud Scheduler ~hourly.
//
// A detected stall (healthy:false) is a SUCCESSFUL check → 200 (we do not
// want Scheduler retrying a correct "pipeline is stuck" result). Only a DB
// probe failure throws → 500 so Scheduler retries the broken probe.
cronRouter.post('/check-stuck-anchors', async (_req, res) => {
  try {
    const result = await runStuckAnchorCheck(db);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Stuck anchor monitor failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── SCRUM-2901 (PI-0.5): Pipeline throughput monitor — dead-man on conversion ───
//
// /health reports anchoring:"ok" while the unlinked public-records backlog
// grows: liveness, not throughput. This endpoint runs TWO dead-man checks
// inside bounded, index-backed probes (no snapshot table, no migration):
//   A — total securing death: new unlinked records in the window while ZERO
//       anchors secured network-wide (chain_timestamp on the 0310 partial
//       index).
//   B — linker stall: the OLDEST unlinked record's age exceeds
//       linker_stall_threshold_hours (default 48) — the exact 2026-07
//       incident shape, where other paths keep securing so A alone is silent.
// Pages via Sentry (one stable fingerprint). Feeder death (Scheduler drift /
// paused feeder crons) is owned by SCRUM-2900, not this monitor.
//
// NOT yet scheduled: the Cloud Scheduler binding is a separate, gated ops
// step (RTE-owned). Same cronAuth as every /jobs/* route.
//
// HTTP semantics mirror /check-stuck-anchors: a DETECTED stall
// (healthy:false) is a CORRECT result → 200 (no Scheduler retry of a true
// finding). Only a broken probe throws → 500 so Scheduler retries the probe.
const ThroughputWindowHoursSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(72)
  .default(DEFAULT_THROUGHPUT_WINDOW_HOURS);

const LinkerStallThresholdHoursSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(168)
  .default(DEFAULT_LINKER_STALL_THRESHOLD_HOURS);

cronRouter.post('/pipeline-throughput-monitor', async (req, res) => {
  try {
    const rawWindow = req.query.window_hours ?? req.body?.window_hours;
    const parsedWindow = ThroughputWindowHoursSchema.safeParse(rawWindow ?? undefined);
    if (!parsedWindow.success) {
      res.status(400).json({
        error: 'Invalid window_hours',
        details: parsedWindow.error.flatten().formErrors,
      });
      return;
    }
    const rawThreshold =
      req.query.linker_stall_threshold_hours ?? req.body?.linker_stall_threshold_hours;
    const parsedThreshold = LinkerStallThresholdHoursSchema.safeParse(rawThreshold ?? undefined);
    if (!parsedThreshold.success) {
      res.status(400).json({
        error: 'Invalid linker_stall_threshold_hours',
        details: parsedThreshold.error.flatten().formErrors,
      });
      return;
    }
    const result = await runPipelineThroughputMonitor(db, {
      windowHours: parsedWindow.data,
      linkerStallThresholdHours: parsedThreshold.data,
    });
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Pipeline throughput monitor failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── SCRUM-2042: DocuSign reconciliation (SOC 2 CC7.2) ───
cronRouter.post('/docusign-reconciliation', async (_req, res) => {
  try {
    const deps = makeReconciliationDeps();
    const result = await reconcileDocusignGaps(deps);
    if (!result.ok) {
      res.status(500).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'DocuSign reconciliation failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── GH #1835: Google Drive changes.watch channel renewal ───
// Drive push channels expire (~7 days). Nothing renewed them before this —
// every Drive connection went silent within a week with no error, no alert,
// and no signal beyond the org dashboard still showing "connected". Renews
// any org_integrations google_drive row whose subscription_expires_at falls
// within the sweep's horizon (default 24h) OR was never registered
// (subscription_id IS NULL — a prior bootstrap failure). Each successful
// renewal also mints a fresh random channel_token (GH #1836 rotation) rather
// than reusing whatever token — including a legacy org-id one — the
// connection currently carries. Idempotent (UPDATE by row id only).
// Production trigger: Cloud Scheduler (see scripts/gcp-setup/cloud-scheduler.sh).
cronRouter.post('/drive-subscription-renewal', async (_req, res) => {
  try {
    const result = await renewDriveSubscriptions({
      db: makeDriveSubscriptionRenewalDb(),
      client: makeDriveSubscriptionRenewalClient(),
      alert: alertDriveSubscriptionRenewal,
    });
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Drive subscription renewal failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── DS-05 (SCRUM-2365): DocuSign QUEUE reconciliation ───
// Detects completed envelopes MISSING from the connector-artifact queue
// (distinct from the SCRUM-2042 webhook-delivery gap check above), fires drift
// alerts + bounded audit events, and idempotently re-materializes missing
// org/member queue items via the audited DS-03 producer path (§1.6A: no bytes
// here). Gated OFF by default via ENABLE_DOCUSIGN_QUEUE_RECONCILIATION — the
// re-materialization goes through the producer, itself gated by
// ENABLE_CONNECTOR_ARTIFACT_ENQUEUE. Scheduler: daily (Cloud Scheduler → HTTP).
cronRouter.post('/docusign-queue-reconciliation', async (_req, res) => {
  if (!config.enableDocusignQueueReconciliation) {
    res.json({ skipped: true, reason: 'ENABLE_DOCUSIGN_QUEUE_RECONCILIATION disabled' });
    return;
  }
  try {
    const result = await withCronMonitoring(
      'docusign-queue-reconciliation',
      '0 7 * * *',
      () =>
        reconcileDocusignQueueDrift(makeQueueReconciliationDeps(), {
          // Flag alignment: with the connector-artifact enqueue OFF the DS-03
          // producer writes no durable row, so a re-drive can never queue the
          // envelope. Pass the flag so reconciliation still surfaces drift (audit +
          // Sentry) but suppresses a re-submit-every-run loop.
          enableConnectorArtifactEnqueue: config.enableConnectorArtifactEnqueue,
        }),
    )();
    if (!result.ok) {
      res.status(500).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'DocuSign queue reconciliation failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── SCRUM-2099 [DS-FAIL-01]: DocuSign Connect Failures hourly poller ───
// Surgical complement to the 24h Envelopes reconciliation above: polls
// DocuSign's own Connect Failures API hourly and dedups new gaps against the
// shared docusign_reconciliation_gaps table. Catches gaps within ~1h.
cronRouter.post('/docusign-connect-failures-poll', async (_req, res) => {
  try {
    const result = await withCronMonitoring(
      'docusign-connect-failures-poll',
      '0 * * * *',
      () => pollDocusignConnectFailures(makeConnectFailuresDeps()),
    )();
    if (!result.ok) {
      res.status(500).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'DocuSign Connect failures poll failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── SCRUM-2098 [DS-LISTEN-01]: DocuSign listener config drift check ───
// Detection only: reads DocuSign Connect config and emits alerts; no DocuSign
// listener writes. Cloud Scheduler binding lives in scripts/gcp-setup/cloud-scheduler.sh.
cronRouter.post('/docusign-listener-drift', async (_req, res) => {
  try {
    const result = await reconcileListenerDrift(makeListenerDriftDeps());
    if (!result.ok) {
      res.status(500).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'DocuSign listener drift reconciliation failed');
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── Production Smoke Test (P7-TS-06) ───

cronRouter.post('/smoke-test', async (_req, res) => {
  try {
    const results = await runSmokeTestSuite();
    const passed = results.filter((r) => r.status === 'pass').length;
    const failed = results.filter((r) => r.status === 'fail').length;
    // SCRUM-1247 (R0-1): include the deployed git SHA so smoke output is
    // self-attesting — operators can see in the same payload what code
    // is being smoked.
    const gitSha = getBuildSha();

    // Store results in audit_events for history
    try {
      await db.from('audit_events').insert({
        event_type: 'smoke_test.completed',
        event_category: 'SYSTEM',
        org_id: null,
        details: JSON.stringify({
          passed,
          failed,
          total: results.length,
          results,
          gitSha,
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
      gitSha,
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
      .is('org_id', null)
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

// ────────────────────────────────────────────────────────────────────────────
// BigQuery export jobs (SCRUM-1062 GCP-MAX-02 / SCRUM-1723 / SCRUM-1724 /
// SCRUM-1727). Lazily-imported so the worker boot path doesn't pay the cost
// when these routes are never hit.
// ────────────────────────────────────────────────────────────────────────────

cronRouter.post('/bq-export-incremental', async (_req, res) => {
  try {
    const { runIncremental } = await import('../jobs/bq-export-incremental.js');
    // Sentry Crons monitor — the freshness SLO for append-only mirrors is
    // 5 min (SCRUM-1062 AC). Wrapping the run with withCronMonitoring gives
    // Sentry a heartbeat each tick; if 2 ticks miss the monitor fires.
    // Combined with the consecutive-failures issue alert, this catches both
    // "cron stops firing" (this monitor) and "cron fires but errors" (issue
    // alert from the captureException calls in runIncremental).
    const monitored = withCronMonitoring(
      'bq-export-incremental',
      '*/5 * * * *',
      runIncremental,
    );
    const results = await monitored();
    res.json({ results });
  } catch (error) {
    logger.error({ error }, 'BQ export incremental run failed');
    res.status(500).json({ error: 'BQ incremental sync failed' });
  }
});

cronRouter.post('/bq-export-snapshot', async (_req, res) => {
  try {
    const { runSnapshot } = await import('../jobs/bq-export-snapshot.js');
    // Sentry Crons monitor — daily 02:00 UTC freshness SLO (SCRUM-1062 AC,
    // 24h for snapshot tables).
    const monitored = withCronMonitoring(
      'bq-export-snapshot',
      '0 2 * * *',
      runSnapshot,
    );
    const results = await monitored();
    res.json({ results });
  } catch (error) {
    logger.error({ error }, 'BQ export snapshot run failed');
    res.status(500).json({ error: 'BQ snapshot sync failed' });
  }
});

cronRouter.post('/bq-export-backfill', async (req, res) => {
  // Manual one-shot endpoint. Caller specifies ?table=<name>; only the 3
  // append-only tables are accepted (organizations / api_keys are snapshot
  // tables and use a different write-mode contract).
  const tableParam = typeof req.query.table === 'string' ? req.query.table : '';
  if (!tableParam) {
    res.status(400).json({ error: 'missing query parameter "table" (anchors / verifications / audit_events)' });
    return;
  }
  try {
    const { runBackfill } = await import('../jobs/bq-export-backfill.js');
    const result = await runBackfill(tableParam);
    res.json(result);
  } catch (error) {
    logger.error({ error, table: tableParam }, 'BQ export backfill failed');
    const msg = error instanceof Error ? error.message : 'BQ backfill failed';
    // Return 400 for the "not a backfillable table" guard; 500 for everything else
    const status = msg.includes('not a backfillable table') ? 400 : 500;
    res.status(status).json({ error: msg });
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

  // Check 2: Anchor count sanity (production should have >0).
  //
  // SCRUM-1235: previously used `count: 'exact'` against the 1.4M-row anchors
  // table, which timed out at PostgREST's 60s ceiling on every run. Now uses
  // get_anchor_status_counts_fast() (migration 0182) which derives the total
  // from pg_class.reltuples — instant, regardless of table size.
  const anchorStart = Date.now();
  try {
    const { data, error } = await (db as unknown as {
      rpc: (name: string) => Promise<{ data: { total?: number } | null; error: { message: string } | null }>;
    }).rpc('get_anchor_status_counts_fast');
    if (error) {
      results.push({ name: 'anchor-count', status: 'fail', durationMs: Date.now() - anchorStart, error: error.message });
    } else {
      const total = Number(data?.total ?? 0);
      results.push({
        name: 'anchor-count',
        status: total > 0 ? 'pass' : 'fail',
        durationMs: Date.now() - anchorStart,
        detail: `${total} total anchors`,
      });
    }
  } catch (err) {
    results.push({ name: 'anchor-count', status: 'fail', durationMs: Date.now() - anchorStart, error: String(err) });
  }

  // Check 3: Recent SECURED anchor (should have one within last 7 days).
  //
  // SCRUM-1235: added `.is('deleted_at', null)` and an explicit ORDER BY so
  // the partial index `idx_anchors_status_created` (migration 0174,
  // `WHERE deleted_at IS NULL ORDER BY created_at DESC`) is selected and the
  // LIMIT 1 short-circuits.
  const securedStart = Date.now();
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await db
      .from('anchors')
      .select('created_at')
      .eq('status', 'SECURED')
      .gte('created_at', sevenDaysAgo)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
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

  // Check 5: RLS is enforced on the anchors table.
  //
  // SCRUM-1235: previously a copy-paste of the anchor-count query. That had
  // two problems: (1) `count: 'exact'` timed out on 1.4M rows, and (2) it ran
  // as service_role which BYPASSES RLS — so even when "green" it was testing
  // nothing. Now calls verify_anchors_rls_enabled() (SECURITY DEFINER, reads
  // pg_class.relrowsecurity AND relforcerowsecurity). Fails closed if either
  // flag is off — CLAUDE.md §1.4 requires both.
  const rlsStart = Date.now();
  try {
    const { data, error } = await (db as unknown as {
      rpc: (name: string) => Promise<{ data: boolean | null; error: { message: string } | null }>;
    }).rpc('verify_anchors_rls_enabled');
    if (error) {
      results.push({
        name: 'rls-active',
        status: 'fail',
        durationMs: Date.now() - rlsStart,
        error: error.message,
      });
    } else {
      const enforced = data === true;
      results.push({
        name: 'rls-active',
        status: enforced ? 'pass' : 'fail',
        durationMs: Date.now() - rlsStart,
        detail: enforced
          ? 'RLS enabled and forced on anchors'
          : 'RLS not enforced on anchors (relrowsecurity or relforcerowsecurity is false)',
      });
    }
  } catch (err) {
    results.push({ name: 'rls-active', status: 'fail', durationMs: Date.now() - rlsStart, error: String(err) });
  }

  // Check 6: Build SHA present (SCRUM-1247 / R0-1).
  //
  // The deployed image MUST carry a BUILD_SHA env baked at Docker build
  // (deploy-worker.yml passes --build-arg BUILD_SHA=$github.sha). If env
  // is missing or "unknown" the image was built without the build-arg —
  // either the deploy workflow drifted or someone built locally and
  // pushed manually. Either way operators need to see it.
  const shaStart = Date.now();
  const buildSha = process.env.BUILD_SHA;
  const shaOk = isValidBuildSha(buildSha);
  results.push({
    name: 'build-sha-present',
    status: shaOk ? 'pass' : 'fail',
    durationMs: Date.now() - shaStart,
    detail: shaOk
      ? `BUILD_SHA=${buildSha}`
      : `BUILD_SHA=${buildSha ?? '(unset)'} — image was built without --build-arg BUILD_SHA`,
  });

  return results;
}
