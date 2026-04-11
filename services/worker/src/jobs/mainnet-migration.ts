/**
 * Mainnet Migration Job
 *
 * One-time job to re-anchor all signet anchors on Bitcoin mainnet.
 * Preserves old signet tx_id in metadata before resetting to PENDING.
 * The existing batch-anchor job (10,000/TX, every 5 min) picks them up automatically.
 *
 * Safety: Only runs once — checks metadata.mainnet_migrated flag.
 * Processes in batches of 5,000 to avoid DB timeouts.
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

const MIGRATION_BATCH_SIZE = 5000;

export interface MigrationResult {
  migrated: number;
  skipped: number;
  errors: number;
  batches: number;
}

/**
 * Reset all non-PENDING anchors back to PENDING for mainnet re-anchoring.
 * Stores signet tx data in metadata before reset.
 */
export async function runMainnetMigration(): Promise<MigrationResult> {
  let totalMigrated = 0;
  const totalSkipped = 0;
  let totalErrors = 0;
  let batchCount = 0;

  logger.info('Starting mainnet migration — resetting anchors to PENDING');

   
  while (true) {
    // Fetch a batch of anchors that haven't been migrated yet
    // Exclude PENDING (already ready for mainnet) and any already flagged
    // Include BROADCASTING — these are stuck signet broadcasts that will never confirm
    const { data: anchors, error: fetchError } = await db
      .from('anchors')
      .select('id, status, chain_tx_id, chain_block_height, chain_timestamp, chain_confirmations, metadata')
      .not('status', 'eq', 'PENDING')
      .or('metadata->mainnet_migrated.is.null,metadata->>mainnet_migrated.eq.false')
      .order('created_at', { ascending: true })
      .limit(MIGRATION_BATCH_SIZE);

    if (fetchError) {
      logger.error({ error: fetchError }, 'Failed to fetch anchors for migration');
      totalErrors++;
      break;
    }

    if (!anchors || anchors.length === 0) {
      logger.info('No more anchors to migrate');
      break;
    }

    batchCount++;
    logger.info({ batch: batchCount, count: anchors.length }, 'Processing migration batch');

    for (const anchor of anchors) {
      try {
        // Preserve signet chain data in metadata
        const existingMeta = (anchor.metadata as Record<string, unknown>) || {};
        const updatedMeta = {
          ...existingMeta,
          mainnet_migrated: true,
          signet_tx_id: anchor.chain_tx_id || null,
          signet_block_height: anchor.chain_block_height || null,
          signet_timestamp: anchor.chain_timestamp || null,
          signet_confirmations: anchor.chain_confirmations || null,
          signet_status: anchor.status,
          migration_date: new Date().toISOString(),
        };

        // Reset to PENDING and clear chain data
        const { error: updateError } = await db
          .from('anchors')
          .update({
            status: 'PENDING',
            chain_tx_id: null,
            chain_block_height: null,
            chain_timestamp: null,
            chain_confirmations: null,
            metadata: updatedMeta,
          })
          .eq('id', anchor.id);

        if (updateError) {
          logger.error({ error: updateError, anchorId: anchor.id }, 'Failed to migrate anchor');
          totalErrors++;
        } else {
          totalMigrated++;
        }
      } catch (err) {
        logger.error({ error: err, anchorId: anchor.id }, 'Unexpected error migrating anchor');
        totalErrors++;
      }
    }

    logger.info({
      batch: batchCount,
      migrated: totalMigrated,
      errors: totalErrors,
    }, 'Migration batch complete');
  }

  // Also reset any that are already PENDING but don't have the flag
  // (they were pending on signet and never got processed)
  const { count: pendingCount } = await db
    .from('anchors')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'PENDING');

  logger.info({
    totalMigrated,
    totalSkipped,
    totalErrors,
    batches: batchCount,
    pendingReady: pendingCount,
  }, 'Mainnet migration complete');

  return {
    migrated: totalMigrated,
    skipped: totalSkipped,
    errors: totalErrors,
    batches: batchCount,
  };
}

/**
 * Check migration status — how many anchors still need processing.
 */
export async function getMigrationStatus(): Promise<{
  total: number;
  pending: number;
  secured: number;
  submitted: number;
  migrated: number;
  remaining: number;
}> {
  const { count: total } = await db.from('anchors').select('*', { count: 'exact', head: true });
  const { count: pending } = await db.from('anchors').select('*', { count: 'exact', head: true }).eq('status', 'PENDING');
  const { count: secured } = await db.from('anchors').select('*', { count: 'exact', head: true }).eq('status', 'SECURED');
  const { count: submitted } = await db.from('anchors').select('*', { count: 'exact', head: true }).eq('status', 'SUBMITTED');

  // Count migrated (have mainnet_migrated flag)
  const { count: migrated } = await db
    .from('anchors')
    .select('*', { count: 'exact', head: true })
    .not('metadata->mainnet_migrated', 'is', null);

  return {
    total: total ?? 0,
    pending: pending ?? 0,
    secured: secured ?? 0,
    submitted: submitted ?? 0,
    migrated: migrated ?? 0,
    remaining: (total ?? 0) - (secured ?? 0),
  };
}
