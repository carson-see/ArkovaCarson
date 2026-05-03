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
import { processPendingAnchors } from '../jobs/anchor.js';
import { processBatchAnchors } from '../jobs/batch-anchor.js';
import { checkSubmittedConfirmations } from '../jobs/check-confirmations.js';
import { processRevokedAnchors } from '../jobs/revocation.js';
import { processWebhookRetries } from '../webhooks/delivery.js';
import { processMonthlyCredits } from '../jobs/credit-expiry.js';
import { detectReorgs, monitorStuckTransactions, rebroadcastDroppedTransactions, consolidateUtxos, monitorFeeRates } from '../jobs/chain-maintenance.js';
import { recoverStuckBroadcasts } from '../jobs/broadcast-recovery.js';
import { trackOperation } from './lifecycle.js';
import { withCronMonitoring } from '../utils/sentry.js';

type CronTask = Parameters<typeof cron.schedule>[1];

const ANCHOR_TABLE_IN_PROCESS_JOBS = new Set([
  'recover-stuck-broadcasts',
  'process-pending-anchors',
  'process-batch-anchors',
  'check-submitted-confirmations',
  'process-revoked-anchors',
  'detect-reorgs',
  'monitor-stuck-transactions',
  'rebroadcast-dropped-transactions',
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

  // Process pending anchors every minute (all environments including production)
  if (chainInitialized) {
    scheduleInProcess('process-pending-anchors', '* * * * *', async () => {
      logger.debug('Running scheduled anchor processing (in-process cron)');
      try {
        await trackOperation(processPendingAnchors());
      } catch (error) {
        logger.error({ error }, 'Scheduled anchor processing failed');
      }
    });

    // Batch anchor processing every 10 minutes
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

  logger.info('Scheduled jobs configured (including chain maintenance)');
}
