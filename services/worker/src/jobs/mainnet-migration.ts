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
import { callRpc, type FastCountsRpc } from '../utils/rpc.js';

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

  // SCRUM-1259 (R1-5): pendingCount via the fast RPC instead of count:'exact'
  // on a 1.4M+ row bloated table (would 60s-timeout the migration script).
  const { data: counts, error: countsErr } = await callRpc<FastCountsRpc>(db, 'get_anchor_status_counts_fast');
  const pendingCount = countsErr ? null : (counts?.PENDING ?? null);

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
 *
 * SCRUM-1259 (R1-5): per-status counts via get_anchor_status_counts_fast
 * (replaces 4× count:'exact' fan-out). The mainnet_migrated count is a
 * specialized JSONB-key filter not covered by the RPC; bounded with
 * LIMIT 100k to stay within budget and reported with a `≥` indicator
 * when capped.
 */
export async function getMigrationStatus(): Promise<{
  total: number;
  pending: number;
  secured: number;
  submitted: number;
  migrated: number;
  /** True when `migrated` hit the LIMIT 100000 cap and the real value is ≥ that. */
  migratedCapped: boolean;
  remaining: number;
}> {
  const { data: counts, error: countsErr } = await callRpc<FastCountsRpc>(db, 'get_anchor_status_counts_fast');
  if (countsErr) {
    logger.warn({ error: countsErr }, 'getMigrationStatus: get_anchor_status_counts_fast failed');
  }
  const total = counts?.total ?? -1;
  const pending = counts?.PENDING ?? -1;
  const secured = counts?.SECURED ?? -1;
  const submitted = counts?.SUBMITTED ?? -1;

  // Migrated: filter on `metadata.mainnet_migrated IS NOT NULL` is not in the
  // fast RPC. Bound the scan with LIMIT 100000 so a single call stays in
  // budget; the cap-hit case is signalled to the caller for honest reporting.
  const MIGRATED_CAP = 100_000;
  let migrated = -1;
  let migratedCapped = false;
  try {
    const { data: migratedRows, error: migErr } = await db
      .from('anchors')
      .select('id', { head: false })
      .not('metadata->mainnet_migrated', 'is', null)
      .limit(MIGRATED_CAP);
    if (migErr) {
      logger.warn({ error: migErr }, 'getMigrationStatus: migrated-flag scan failed');
    } else if (Array.isArray(migratedRows)) {
      migrated = migratedRows.length;
      migratedCapped = migrated === MIGRATED_CAP;
    }
  } catch (err) {
    logger.warn({ error: err }, 'getMigrationStatus: migrated-flag scan threw');
  }

  return {
    total: total === -1 ? 0 : total,
    pending: pending === -1 ? 0 : pending,
    secured: secured === -1 ? 0 : secured,
    submitted: submitted === -1 ? 0 : submitted,
    migrated: migrated === -1 ? 0 : migrated,
    migratedCapped,
    remaining: total === -1 || secured === -1 ? -1 : Math.max(total - secured, 0),
  };
}
