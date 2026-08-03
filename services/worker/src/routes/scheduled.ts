/**
 * Scheduled Cron Jobs (In-Process)
 *
 * Belt-and-suspenders backup for dev/test.
 * In production, Cloud Scheduler triggers HTTP endpoints (cronRouter) instead.
 *
 * Extracted from index.ts as part of ARCH-1 refactor.
 */

import cron from 'node-cron';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { db } from '../utils/db.js';
import { callRpc } from '../utils/rpc.js';
import { processBatchAnchors } from '../jobs/batch-anchor.js';
import { checkSubmittedConfirmations } from '../jobs/check-confirmations.js';
import { processRevokedAnchors } from '../jobs/revocation.js';
import { processWebhookRetries, dispatchWebhookEvent } from '../webhooks/delivery.js';
import { processMonthlyCredits } from '../jobs/credit-expiry.js';
import { sweepExpiredAnchors, makeAnchorExpirySweepDb } from '../jobs/anchorExpirySweep.js';
import { detectReorgs, monitorStuckTransactions, rebroadcastDroppedTransactions, consolidateUtxos, monitorFeeRates } from '../jobs/chain-maintenance.js';
import { recoverStuckBroadcasts } from '../jobs/broadcast-recovery.js';
import { runStuckAnchorCheck } from '../jobs/stuck-anchor-monitor.js';
import { runCreditConservationReconciler } from '../jobs/credit-conservation-reconciler.js';
import { runConfirmationProofBackfill } from '../jobs/confirmation-proof-backfill.js';
import { runConnectorArtifactDrain } from '../jobs/connector-artifact-drain.js';
import { runDriveFileChangedJobs } from '../jobs/drive-file-changed.js';
import { trackOperation } from './lifecycle.js';
import { withCronMonitoring } from '../utils/sentry.js';

type CronTask = Parameters<typeof cron.schedule>[1];

/** Narrow an unknown error to its message string (LOW-2 log-hygiene helper). */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const ANCHOR_TABLE_IN_PROCESS_JOBS = new Set([
  'recover-stuck-broadcasts',
  'process-batch-anchors',
  'check-submitted-confirmations',
  'process-revoked-anchors',
  'anchor-expiry-sweep',
  'detect-reorgs',
  'monitor-stuck-transactions',
  'rebroadcast-dropped-transactions',
  // SCRUM-2234: reads the anchors table (oldest-PENDING probe). Skipped under
  // the maintenance flag alongside the other anchor-table jobs so a paused
  // pipeline during a migration window doesn't trip a spurious stall page.
  'check-stuck-anchors',
  // PROOF-03 (SCRUM-2336): confirmation-proof backfill reads SECURED anchors +
  // anchor_proofs. Joins the anchor-table allowlist so the maintenance flag
  // pauses it during a migration window alongside the other anchor-table jobs.
  'populate-confirmation-proofs',
  // QUEUE-06 (SCRUM-2352): connector-artifact drain materializes anchors +
  // charges credits + anchors to Bitcoin. Joins the anchor-table allowlist so a
  // paused pipeline during a migration window doesn't materialize/charge rows.
  'drain-connector-artifacts',
]);

function scheduleInProcess(jobName: string, expression: string, task: CronTask): void {
  if (
    config.nodeEnv === 'production'
    && config.disableInProcessAnchorCron
    && ANCHOR_TABLE_IN_PROCESS_JOBS.has(jobName)
  ) {
    logger.warn(
      { jobName, expression },
      'Skipping in-process anchor cron in production because DISABLE_IN_PROCESS_ANCHOR_CRON=true',
    );
    return;
  }

  cron.schedule(expression, task);
}

export function setupScheduledJobs(chainInitialized: boolean): void {
  // Sentry cron monitoring wrappers (Phase 4, Item 18)
  const monitoredConfirmationCheck = withCronMonitoring(
    'check-confirmations', '*/2 * * * *', checkSubmittedConfirmations,
  );
  const monitoredRevocations = withCronMonitoring(
    'process-revocations', '*/5 * * * *', processRevokedAnchors,
  );
  const monitoredWebhookRetries = withCronMonitoring(
    'webhook-retries', '*/2 * * * *', processWebhookRetries,
  );

  // RACE-1: Recover stuck BROADCASTING anchors every 2 minutes.
  // Runs in all environments — if a worker crashes mid-broadcast, this resets
  // the anchor to PENDING so it can be re-processed.
  scheduleInProcess('recover-stuck-broadcasts', '*/2 * * * *', async () => {
    try {
      const result = await trackOperation(recoverStuckBroadcasts());
      if (result.recovered > 0) {
        logger.warn(
          { recovered: result.recovered },
          'Recovered stuck BROADCASTING anchors',
        );
      }
    } catch (error) {
      logger.error({ error }, 'Broadcast recovery cron failed');
    }
  });

  if (chainInitialized) {
    // Batch policy check every 10 minutes. The job only broadcasts when the
    // batch size/age/forced-flush rules in jobs/batch-anchor.ts are satisfied.
    const batchInterval = config.batchAnchorIntervalMinutes ?? 10;
    scheduleInProcess('process-batch-anchors', `*/${batchInterval} * * * *`, async () => {
      logger.debug('Running scheduled batch anchor processing (in-process cron)');
      try {
        await trackOperation(processBatchAnchors());
      } catch (error) {
        logger.error({ error }, 'Scheduled batch anchor processing failed');
      }
    });
  } else {
    logger.warn('Anchor processing cron DISABLED — chain client not initialized');
  }

  // BETA-01: Check SUBMITTED anchors for blockchain confirmation every 2 minutes
  scheduleInProcess('check-submitted-confirmations', '*/2 * * * *', async () => {
    logger.debug('Running scheduled confirmation check');
    try {
      const result = await trackOperation(monitoredConfirmationCheck());
      if (result.confirmed > 0) {
        logger.info({ confirmed: result.confirmed, checked: result.checked }, 'Confirmed anchors');
      }
    } catch (error) {
      logger.error({ error }, 'Scheduled confirmation check failed');
    }
  });

  // BETA-02: Process revoked anchors every 5 minutes
  scheduleInProcess('process-revoked-anchors', '*/5 * * * *', async () => {
    logger.debug('Running scheduled revocation processing');
    try {
      const result = await trackOperation(monitoredRevocations());
      if (result.processed > 0) {
        logger.info({ processed: result.processed, failed: result.failed }, 'Processed revocations');
      }
    } catch (error) {
      logger.error({ error }, 'Scheduled revocation processing failed');
    }
  });

  // Process webhook retries every 2 minutes
  scheduleInProcess('process-webhook-retries', '*/2 * * * *', async () => {
    logger.debug('Running scheduled webhook retry processing');
    try {
      const retried = await trackOperation(monitoredWebhookRetries());
      if (retried > 0) {
        logger.info({ retried }, 'Processed webhook retries');
      }
    } catch (error) {
      logger.error({ error }, 'Scheduled webhook retry processing failed');
    }
  });

  // Monthly credit allocation on 1st at midnight
  scheduleInProcess('process-monthly-credits', '0 0 1 * *', async () => {
    logger.info('Running monthly credit allocation');
    try {
      const processed = await processMonthlyCredits();
      logger.info({ processed }, 'Monthly credit allocation complete');
    } catch (error) {
      logger.error({ error }, 'Monthly credit allocation failed');
    }
  });

  // S1-9 (SCRUM-2349 / PM-25): money-conservation reconciler — daily at 09:00
  // UTC (deliberately offset from the 03:00 batch flush). Calls the prod
  // `org_credit_ledger_divergence` SQL function over ALL orgs (read-only),
  // emits a structured conservation report, and pages (error log + Sentry) on
  // any drift — the gate #11 SLO/alerting signal. Read-only reconciliation, so
  // it is NOT in ANCHOR_TABLE_IN_PROCESS_JOBS: a paused anchor pipeline under
  // the maintenance flag must NOT silence money-conservation checks, and the
  // function touches credit ledger tables, not the anchors table. Idempotent —
  // a missed/retried tick just re-reads. In-process backup; prod runs via
  // Cloud Scheduler hitting /jobs/reconcile-credit-conservation (Carson wires
  // the scheduler binding — T3, serialized).
  scheduleInProcess('reconcile-credit-conservation', '0 9 * * *', async () => {
    logger.debug('Running credit-conservation reconciler');
    try {
      const result = await trackOperation(runCreditConservationReconciler(db));
      if (!result.healthy) {
        // PII-safe: the result carries counts only, never raw balances.
        logger.warn(
          { divergedCount: result.divergedCount, orgsChecked: result.orgsChecked },
          'Credit-conservation reconciler: drift detected',
        );
      }
    } catch (error) {
      logger.error({ error }, 'Credit-conservation reconciler cron failed');
    }
  });

  // SCRUM-1736: anchor expiry sweep — daily at 03:00 UTC. Transitions
  // SECURED anchors past expires_at to EXPIRED + fires anchor.expired
  // webhook. In-process backup; prod runs via Cloud Scheduler hitting
  // /jobs/anchor-expiry-sweep.
  scheduleInProcess('anchor-expiry-sweep', '0 3 * * *', async () => {
    logger.info('Running anchor expiry sweep');
    try {
      const adapter = makeAnchorExpirySweepDb({ db, dispatchWebhookEvent });
      const result = await sweepExpiredAnchors(adapter);
      logger.info(result, 'Anchor expiry sweep complete');
    } catch (error) {
      logger.error({ error }, 'Anchor expiry sweep failed');
    }
  });

  // SCRUM-2234: stuck anchor monitor — hourly. Pages (error log + Sentry) when
  // the oldest non-deleted PENDING anchor exceeds STUCK_ANCHOR_ALERT_HOURS
  // (default 24h). In-process backup; prod runs via Cloud Scheduler hitting
  // /jobs/check-stuck-anchors. The 2026-06-01 daily-flush 401 blackout drained
  // nothing for ~6 weeks with no alert — this is the missing watchdog.
  scheduleInProcess('check-stuck-anchors', '0 * * * *', async () => {
    logger.debug('Running stuck anchor monitor');
    try {
      const result = await trackOperation(runStuckAnchorCheck(db));
      if (!result.healthy) {
        logger.warn(result, 'Stuck anchor monitor: pipeline stall detected');
      }
    } catch (error) {
      logger.error({ error }, 'Stuck anchor monitor cron failed');
    }
  });

  // PII-03: GDPR data retention cleanup — daily at 2:00 AM UTC
  scheduleInProcess('cleanup-expired-data', '0 2 * * *', async () => {
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

  // Bitcoin Audit: Chain maintenance jobs
  // CRIT-2: Reorg detection every 10 minutes
  scheduleInProcess('detect-reorgs', '*/10 * * * *', async () => {
    try {
      const result = await trackOperation(detectReorgs());
      if (result.reorgsDetected > 0) {
        logger.warn({ ...result }, 'Reorg detection found issues');
      }
    } catch (error) {
      logger.error({ error }, 'Reorg detection cron failed');
    }
  });

  // NET-1: Stuck TX monitor every 10 minutes
  scheduleInProcess('monitor-stuck-transactions', '*/10 * * * *', async () => {
    try {
      const result = await trackOperation(monitorStuckTransactions());
      if (result.stuck > 0) {
        logger.warn({ ...result }, 'Stuck transactions detected');
      }
    } catch (error) {
      logger.error({ error }, 'Stuck TX monitor cron failed');
    }
  });

  // NET-3: Rebroadcast dropped TXs every 6 hours
  scheduleInProcess('rebroadcast-dropped-transactions', '0 */6 * * *', async () => {
    try {
      await trackOperation(rebroadcastDroppedTransactions());
    } catch (error) {
      logger.error({ error }, 'TX rebroadcast cron failed');
    }
  });

  // INEFF-1: UTXO consolidation daily at 4:00 AM UTC
  scheduleInProcess('consolidate-utxos', '0 4 * * *', async () => {
    try {
      await trackOperation(consolidateUtxos());
    } catch (error) {
      logger.error({ error }, 'UTXO consolidation cron failed');
    }
  });

  // NET-6: Fee monitoring every 10 minutes
  scheduleInProcess('monitor-fee-rates', '*/10 * * * *', async () => {
    try {
      await trackOperation(monitorFeeRates());
    } catch (error) {
      logger.error({ error }, 'Fee monitoring cron failed');
    }
  });

  // PROOF-03 (SCRUM-2336): confirmation-proof backfill every 15 minutes.
  // Populates the 80-byte block header + Merkle inclusion path for SECURED
  // anchors whose app-tree branch is complete but bitcoin-tree evidence is
  // missing (block_header IS NULL). Bounded (≤2000 rows/run), idempotent (the
  // populated block_header is the watermark), and DELIBERATELY decoupled from
  // the latency-critical 2-minute check-confirmations drain. Default OFF —
  // enabled per-environment via ENABLE_CONFIRMATION_PROOF_BACKFILL (the wrapper
  // additionally no-ops unless ENABLE_PROD_NETWORK_ANCHORING yields a real
  // inclusion-proof provider).
  if (config.enableConfirmationProofBackfill) {
    scheduleInProcess('populate-confirmation-proofs', '*/15 * * * *', async () => {
      logger.debug('Running confirmation-proof backfill');
      try {
        const result = await trackOperation(runConfirmationProofBackfill());
        if (!result.skipped && result.anchorsUpdated > 0) {
          logger.info(
            { anchorsUpdated: result.anchorsUpdated, txConfirmed: result.txConfirmed, scanned: result.scanned },
            'Confirmation-proof backfill populated anchors',
          );
        }
      } catch (error) {
        // LOW-2: log the message string (not the raw error object) so a future
        // richer error can't drag rpcUrl/token-bearing fields into the log.
        logger.error({ err: errMsg(error) }, 'Confirmation-proof backfill cron failed');
      }
    });
  }

  // QUEUE-06 (SCRUM-2352): connector-artifact drain every 5 minutes. Drains
  // pending|queued connector_artifact rows → materialize PENDING anchor →
  // charge at SECURING (debit_and_enqueue_anchor) → batch-anchor. Default OFF —
  // enabled per-environment via ENABLE_CONNECTOR_ARTIFACT_DRAIN. In-process is
  // the dev/test BACKUP ONLY: node-cron is dormant under Cloud Run CPU
  // throttling, so prod drives this via Cloud Scheduler → POST
  // /jobs/drain-connector-artifacts. Idempotent (compare-and-set claim).
  if (config.enableConnectorArtifactDrain) {
    scheduleInProcess('drain-connector-artifacts', '*/5 * * * *', async () => {
      logger.debug('Running connector-artifact drain');
      try {
        const result = await trackOperation(runConnectorArtifactDrain());
        if (!result.skipped && result.anchored > 0) {
          logger.info(
            { anchored: result.anchored, failed: result.failed, orgsProcessed: result.orgsProcessed },
            'Connector-artifact drain anchored rows',
          );
        }
      } catch (error) {
        logger.error({ err: errMsg(error) }, 'Connector-artifact drain cron failed');
      }
    });
  }

  // SCRUM-2903 (GD-PROD): Drive file-changed job drain every 5 minutes. Drains
  // the `google_drive.file_changed` queue that drive-changes-runner.ts writes
  // on a matched change: fetch bytes -> SHA-256 in memory -> discard ->
  // enqueue_connector_artifact (§1.6A) for the existing connector-artifact
  // drain to anchor. Default OFF alongside ENABLE_CONNECTOR_ARTIFACT_ENQUEUE —
  // when that flag is false the job runs but no-ops the hash/enqueue step per
  // job (returns the disabled sentinel), so there's nothing to gain by polling.
  // In-process is the dev/test BACKUP ONLY: prod runs via Cloud Scheduler ->
  // POST /jobs/drive-file-changed (node-cron is dormant under Cloud Run CPU
  // throttling, same as connector-artifact-drain above).
  if (config.enableConnectorArtifactEnqueue) {
    scheduleInProcess('drive-file-changed', '*/5 * * * *', async () => {
      logger.debug('Running Drive file-changed job drain');
      try {
        const result = await trackOperation(runDriveFileChangedJobs());
        if (result.completed > 0 || result.failed > 0) {
          logger.info(
            { completed: result.completed, failed: result.failed, dead: result.dead },
            'Drive file-changed job drain processed jobs',
          );
        }
      } catch (error) {
        logger.error({ err: errMsg(error) }, 'Drive file-changed job drain cron failed');
      }
    });
  }

  // GH #1835: Drive changes.watch channel renewal, hourly. Deliberately NO
  // in-process backup here — prod runs it exclusively via Cloud Scheduler ->
  // POST /jobs/drive-subscription-renewal (routes/cron.ts). Its sibling
  // docusign-reconciliation (SCRUM-2042, same file-organization shape:
  // Cloud-Scheduler-only cron.ts route, no scheduleInProcess entry) is the
  // established precedent — when the Cloud Run instance is NOT throttled,
  // an unconditional in-process schedule running the SAME hourly cadence
  // would double-fire every tick: two concurrent sweeps racing to renew the
  // same due connections, each independently stopping the other's
  // just-registered channel. Dev/test coverage lives entirely in
  // drive-subscription-renewal.test.ts (pure orchestrator) and
  // drive-subscription-renewal-deps.test.ts (real wiring) instead of an
  // in-process cron loop.

  logger.info('Scheduled jobs configured (including chain maintenance)');
}
