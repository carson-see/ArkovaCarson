/**
 * Batch Anchor Processing Job (MVP-23)
 *
 * Processes batches of anchors by combining fingerprints into a
 * Merkle tree and publishing the root as a single Bitcoin transaction.
 *
 * Uses claim-before-broadcast pattern (RACE-1):
 *   PENDING → (claim RPC) → BROADCASTING → (chain submit) → SUBMITTED
 *
 * Feature-gated by ENABLE_BATCH_ANCHORING switchboard flag.
 *
 * Constitution refs:
 *   - 1.4: Setting anchor.status = 'SUBMITTED'/'SECURED' is worker-only via service_role
 *   - 1.9: ENABLE_BATCH_ANCHORING gates batch processing
 */

import { db, withDbTimeout } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { getChainClient } from '../chain/client.js';
import { buildMerkleTree } from '../utils/merkle.js';
import { getComplianceControlIds } from '../utils/complianceMapping.js';
import { config } from '../config.js';

/**
 * Max anchors per batch transaction (BTC-001).
 * HARDCODED to 10,000. One Merkle root per TX covers unlimited anchors at the same
 * Bitcoin cost. Small batches waste UTXOs and drain treasury.
 * Env override only allowed to go LOWER (for testing), never below 100.
 */
export const BATCH_SIZE = Math.min(
  Math.max(parseInt(process.env.BATCH_ANCHOR_MAX_SIZE ?? '10000', 10) || 10000, 100),
  10000,
);

/**
 * INEFF-2: Minimum anchors required for batch processing.
 * Lowered from 2 to 1 so ALL anchors benefit from Merkle batching.
 */
export const MIN_BATCH_SIZE = 1;

/**
 * SCALE-1: Smart batch skipping — don't burn a UTXO + fee for tiny batches.
 * Skip if fewer than this many anchors pending AND oldest is under MAX_ANCHOR_AGE_MS.
 * Guarantees no anchor waits more than MAX_ANCHOR_AGE_MS regardless.
 */
export const MIN_BATCH_THRESHOLD = 5;
export const MAX_ANCHOR_AGE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * SCALE-2: Absolute hard cap for dynamic fee ceiling (sat/vB).
 * Even during severe backlogs, never exceed this rate.
 */
export const ABSOLUTE_FEE_CAP_SAT_PER_VB = 200;

// =============================================================================
// ARK-102 (SCRUM-1012): Pinned Trigger A/B/C decision points
// =============================================================================
//
// The batch processor fires a Bitcoin transaction when ANY of three triggers
// is satisfied. The audit tests in `batch-anchor.audit.test.ts` pin the
// behavior of these triggers; the pure functions below make them
// independently testable.

/**
 * Trigger A — Size-based: fire immediately when the claimed count is at or
 * above BATCH_SIZE. Enforced implicitly by the claim loop (see
 * `_processBatchAnchorsInner`), since we never claim more than BATCH_SIZE
 * at once. Helper here is purely for documentation + audit pinning.
 */
export function triggerA_shouldFireOnSize(claimedCount: number): boolean {
  return claimedCount >= BATCH_SIZE;
}

/**
 * Trigger B — Age-based: even if pending count is below MIN_BATCH_THRESHOLD,
 * force a batch when the oldest pending anchor has been waiting longer than
 * MAX_ANCHOR_AGE_MS. Guarantees no anchor sits PENDING for more than that
 * window (modulo cron cadence).
 */
export function triggerB_shouldFireOnAge(input: {
  pendingCount: number;
  oldestPendingAgeMs: number;
}): boolean {
  if (input.pendingCount === 0) return false;
  if (input.pendingCount >= MIN_BATCH_THRESHOLD) return true;
  return input.oldestPendingAgeMs >= MAX_ANCHOR_AGE_MS;
}

/**
 * Trigger C — Fee-aware: defer the batch when the current fee rate exceeds
 * the dynamic ceiling. The ceiling scales with backlog age so a very-stale
 * backlog still ships, but bounded by ABSOLUTE_FEE_CAP_SAT_PER_VB.
 *
 * Returns the effective ceiling. Caller compares against the live rate.
 */
export function triggerC_computeFeeCeiling(input: {
  baseCeiling: number;
  oldestPendingAgeMs: number;
}): number {
  const THIRTY_MIN = 30 * 60 * 1000;
  const ONE_HOUR = 60 * 60 * 1000;
  let ceiling = input.baseCeiling;
  if (input.oldestPendingAgeMs > ONE_HOUR) ceiling = input.baseCeiling * 4;
  else if (input.oldestPendingAgeMs > THIRTY_MIN) ceiling = input.baseCeiling * 2;
  return Math.min(ceiling, ABSOLUTE_FEE_CAP_SAT_PER_VB);
}

export interface BatchAnchorResult {
  processed: number;
  batchId: string | null;
  merkleRoot: string | null;
  txId: string | null;
}

/**
 * PostgREST row limit per response. Supabase caps RPC results at 1000 rows.
 * We claim in chunks of this size and accumulate up to BATCH_SIZE.
 */
const POSTGREST_ROW_LIMIT = 1000;

/**
 * SCALE-3: In-process mutex — prevents overlapping batch runs when cron fires
 * faster than batch processing completes. Same pattern as confirmation checker.
 */
let batchProcessingRunning = false;

/**
 * Process pending anchors as a batch using a Merkle tree.
 *
 * Uses claim-before-broadcast pattern:
 * 1. Atomically claim PENDING → BROADCASTING via RPC (chunked to avoid PostgREST 1000-row cap)
 * 2. Build Merkle tree from claimed anchors
 * 3. Publish Merkle root to chain
 * 4. Update each anchor: BROADCASTING → SUBMITTED with tx ID + proof
 *
 * SCALE-1: Smart skip — don't waste UTXOs on tiny batches
 * SCALE-2: Pre-claim fee check with dynamic ceiling based on backlog age
 * SCALE-3: In-process mutex prevents overlapping runs
 */
export async function processBatchAnchors(): Promise<BatchAnchorResult> {
  const EMPTY: BatchAnchorResult = { processed: 0, batchId: null, merkleRoot: null, txId: null };

  // SCALE-3: Mutex — skip if already running
  if (batchProcessingRunning) {
    logger.info('Batch processing skipped — already in progress');
    return EMPTY;
  }
  batchProcessingRunning = true;
  try {
    return await _processBatchAnchorsInner();
  } finally {
    batchProcessingRunning = false;
  }
}

async function _processBatchAnchorsInner(): Promise<BatchAnchorResult> {
  const EMPTY: BatchAnchorResult = { processed: 0, batchId: null, merkleRoot: null, txId: null };

  // Phase 0a: Pre-flight UTXO check — skip immediately if treasury is empty.
  const chainClient = getChainClient();
  try {
    if (chainClient.hasFunds) {
      const funded = await chainClient.hasFunds();
      if (!funded) {
        logger.warn('Treasury empty — skipping batch anchor processing until funded');
        return EMPTY;
      }
    }
  } catch (err) {
    logger.warn({ error: err }, 'Pre-flight UTXO check failed — proceeding cautiously');
  }

  // Phase 0b: SCALE-1 — Smart batch skip + backlog age check
  let oldestPendingAgeMs = 0;
  try {
    const { data: stats } = await db
      .from('anchors')
      .select('created_at')
      .eq('status', 'PENDING')
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .single();

    if (!stats) {
      logger.debug('No pending anchors — skipping batch');
      return EMPTY;
    }

    oldestPendingAgeMs = Date.now() - new Date(stats.created_at).getTime();

    // Count pending (cheap — uses index)
    const { count } = await db
      .from('anchors')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'PENDING')
      .is('deleted_at', null);

    const pendingCount = count ?? 0;

    if (!triggerB_shouldFireOnAge({ pendingCount, oldestPendingAgeMs })) {
      logger.debug(
        { pendingCount, oldestAgeMs: oldestPendingAgeMs },
        'Below batch threshold and oldest anchor is fresh — deferring',
      );
      return EMPTY;
    }
  } catch (err) {
    logger.warn({ error: err }, 'Smart batch skip check failed — proceeding with batch');
  }

  // Phase 0c: SCALE-2 — Pre-claim fee check with dynamic ceiling
  try {
    if (chainClient.estimateCurrentFee) {
      const currentFee = await chainClient.estimateCurrentFee();
      const baseCeiling = config.maxFeeThresholdSatPerVbyte ?? 50;
      const effectiveCeiling = triggerC_computeFeeCeiling({ baseCeiling, oldestPendingAgeMs });

      if (currentFee > effectiveCeiling) {
        logger.warn(
          { currentFee, effectiveCeiling, baseCeiling, oldestPendingAgeMs },
          'Fee rate exceeds ceiling — deferring batch until fees drop',
        );
        return EMPTY;
      }

      logger.debug({ currentFee, effectiveCeiling }, 'Fee pre-check passed');
    }
  } catch (err) {
    logger.warn({ error: err }, 'Pre-claim fee check failed — proceeding cautiously');
  }

  // Phase 1: Claim anchors in chunks (PostgREST caps RPC responses at 1000 rows)
  const allClaimed: Array<{ id: string; fingerprint: string; metadata: unknown; user_id?: string; org_id?: string; public_id?: string; credential_type?: string }> = [];
  let remaining = BATCH_SIZE;

  while (remaining > 0) {
    const chunkSize = Math.min(remaining, POSTGREST_ROW_LIMIT);
    // Wrapped in 30s timeout to prevent batch job from hanging
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let chunkResult: { data: any; error: any };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chunkResult = await withDbTimeout(() => (db.rpc as any)('claim_pending_anchors', {
        p_worker_id: `batch-${process.pid}`,
        p_limit: chunkSize,
        p_exclude_pipeline: false,
      }), 30_000);
    } catch (timeoutErr) {
      logger.error({ error: timeoutErr, claimedSoFar: allClaimed.length }, 'claim_pending_anchors timed out in batch');
      if (allClaimed.length === 0) {
        return { processed: 0, batchId: null, merkleRoot: null, txId: null };
      }
      break; // Proceed with what we have
    }
    const { data: chunk, error: claimError } = chunkResult;

    if (claimError) {
      if (allClaimed.length === 0) {
        logger.warn({ error: claimError }, 'claim_pending_anchors RPC failed — falling back to legacy batch');
        return legacyProcessBatchAnchors();
      }
      // Partial claim succeeded — proceed with what we have
      logger.warn({ error: claimError, claimedSoFar: allClaimed.length }, 'claim_pending_anchors chunk failed — proceeding with partial batch');
      break;
    }

    if (!chunk || !Array.isArray(chunk) || chunk.length === 0) break;
    allClaimed.push(...chunk);
    remaining -= chunk.length;

    // If we got fewer than requested, no more PENDING anchors
    if (chunk.length < chunkSize) break;
  }

  const claimedAnchors = allClaimed;

  if (claimedAnchors.length < MIN_BATCH_SIZE) {
    return { processed: 0, batchId: null, merkleRoot: null, txId: null };
  }

  logger.info({ claimed: claimedAnchors.length, target: BATCH_SIZE }, 'Claimed anchors for batch processing');

  const fingerprints = claimedAnchors.map((a: { fingerprint: string }) => a.fingerprint);

  // Phase 2: Build Merkle tree
  const tree = buildMerkleTree(fingerprints);

  // Phase 3: Publish Merkle root to chain
  let receipt;
  try {
    const chainClient = getChainClient();
    receipt = await chainClient.submitFingerprint({
      fingerprint: tree.root,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({ error, merkleRoot: tree.root, count: claimedAnchors.length }, 'Batch anchor chain submission failed — bulk reverting claims');
    await bulkRevertToPending(claimedAnchors.map(a => a.id));
    return { processed: 0, batchId: null, merkleRoot: tree.root, txId: null };
  }

  if (!receipt || !receipt.receiptId) {
    logger.error({ merkleRoot: tree.root }, 'Batch chain broadcast returned empty receipt — bulk reverting claims');
    await bulkRevertToPending(claimedAnchors.map(a => a.id));
    return { processed: 0, batchId: null, merkleRoot: tree.root, txId: null };
  }

  // Phase 4: Bulk update all claimed anchors BROADCASTING → SUBMITTED in one RPC call
  // (Individual PostgREST updates timeout under load — use DB-side bulk function)
  const batchId = `batch_${Date.now()}_${claimedAnchors.length}`;
  const anchorIds = claimedAnchors.map((a: { id: string }) => a.id);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: updatedCount, error: bulkError } = await (db.rpc as any)('submit_batch_anchors', {
    p_anchor_ids: anchorIds,
    p_tx_id: receipt.receiptId,
    p_block_height: receipt.blockHeight ?? null,
    p_block_timestamp: receipt.blockTimestamp ?? null,
    p_merkle_root: tree.root,
    p_batch_id: batchId,
  });

  if (bulkError) {
    // M1: Revert to PENDING instead of N+1 individual updates.
    // Let the recovery cron re-process these on the next run.
    logger.warn({ error: bulkError }, 'submit_batch_anchors RPC failed — bulk reverting claimed anchors to PENDING');
    await bulkRevertToPending(claimedAnchors.map(a => a.id));
    return { processed: 0, batchId: null, merkleRoot: tree.root, txId: receipt.receiptId };
  }

  const processed = typeof updatedCount === 'number' ? updatedCount : (claimedAnchors.length);

  // CML-02: Populate compliance_controls per credential type (non-fatal post-processing)
  try {
    const byType = new Map<string | null, string[]>();
    for (const anchor of claimedAnchors) {
      const ct = (anchor as { credential_type?: string | null }).credential_type ?? null;
      if (!byType.has(ct)) byType.set(ct, []);
      byType.get(ct)!.push(anchor.id);
    }
    for (const [credType, ids] of byType) {
      const controls = getComplianceControlIds(credType);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).from('anchors').update({ compliance_controls: controls }).in('id', ids);
    }
  } catch (complianceErr) {
    logger.warn({ error: complianceErr }, 'Non-fatal: failed to set compliance_controls on batch anchors');
  }

  logger.info(
    {
      batchId,
      count: processed,
      total: claimedAnchors.length,
      merkleRoot: tree.root,
      txId: receipt.receiptId,
    },
    'Batch anchor processing complete',
  );

  return {
    processed,
    batchId,
    merkleRoot: tree.root,
    txId: receipt.receiptId,
  };
}

/** Revert a single batch anchor from BROADCASTING back to PENDING */
async function revertBatchAnchorToPending(anchorId: string): Promise<void> {
  try {
    await db
      .from('anchors')
      .update({ status: 'PENDING' })
      .eq('id', anchorId)
      .eq('status', 'BROADCASTING');
  } catch (err) {
    logger.error({ anchorId, error: err }, 'Failed to revert batch anchor to PENDING');
  }
}

/**
 * Bulk revert anchors from BROADCASTING to PENDING using batched IN queries.
 * Much faster than individual updates — prevents 504 timeouts on large batches.
 */
async function bulkRevertToPending(anchorIds: string[]): Promise<void> {
  const CHUNK_SIZE = 500;
  for (let i = 0; i < anchorIds.length; i += CHUNK_SIZE) {
    const chunk = anchorIds.slice(i, i + CHUNK_SIZE);
    try {
      const { error } = await db
        .from('anchors')
        .update({ status: 'PENDING' })
        .in('id', chunk)
        .eq('status', 'BROADCASTING');
      if (error) {
        logger.error({ error, chunkStart: i, chunkSize: chunk.length }, 'Bulk revert chunk failed — falling back to individual');
        for (const id of chunk) {
          await revertBatchAnchorToPending(id);
        }
      }
    } catch (err) {
      logger.error({ error: err, chunkStart: i }, 'Bulk revert chunk threw — falling back to individual');
      for (const id of chunk) {
        await revertBatchAnchorToPending(id);
      }
    }
  }
  logger.info({ count: anchorIds.length }, 'Bulk reverted BROADCASTING → PENDING');
}

/**
 * Legacy fallback: batch processing without claim RPC.
 * Used when migration 0111 hasn't been applied yet.
 */
async function legacyProcessBatchAnchors(): Promise<BatchAnchorResult> {
  const { data: pendingAnchors, error: fetchError } = await db
    .from('anchors')
    .select('id, fingerprint, metadata, credential_type')
    .eq('status', 'PENDING')
    .is('chain_tx_id', null)
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (fetchError) {
    logger.error({ error: fetchError }, 'Failed to fetch pending anchors for batch');
    return { processed: 0, batchId: null, merkleRoot: null, txId: null };
  }

  if (!pendingAnchors || pendingAnchors.length < MIN_BATCH_SIZE) {
    return { processed: 0, batchId: null, merkleRoot: null, txId: null };
  }

  const fingerprints = pendingAnchors.map((a) => a.fingerprint);
  const tree = buildMerkleTree(fingerprints);

  let receipt;
  try {
    const chainClient = getChainClient();
    receipt = await chainClient.submitFingerprint({
      fingerprint: tree.root,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({ error, merkleRoot: tree.root }, 'Legacy batch chain submission failed');
    return { processed: 0, batchId: null, merkleRoot: tree.root, txId: null };
  }

  const batchId = `batch_${Date.now()}_${pendingAnchors.length}`;
  const anchorIds = pendingAnchors.map((a) => a.id);

  // Bulk update all anchors PENDING → SUBMITTED in one RPC call
  // (Individual PostgREST updates timeout under load — use DB-side bulk function)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: bulkCount, error: bulkError } = await (db.rpc as any)('submit_batch_anchors', {
    p_anchor_ids: anchorIds,
    p_tx_id: receipt.receiptId,
    p_block_height: receipt.blockHeight ?? null,
    p_block_timestamp: receipt.blockTimestamp ?? null,
    p_merkle_root: tree.root,
    p_batch_id: batchId,
  });

  if (bulkError) {
    // Fallback: try individual updates if RPC not available
    logger.warn({ error: bulkError }, 'submit_batch_anchors RPC failed in legacy path — falling back to individual updates');
    let updatedCount = 0;

    for (const anchor of pendingAnchors) {
      const { error: updateError, count: updateCount } = await db
        .from('anchors')
        .update({
          status: 'SUBMITTED' as const,
          chain_tx_id: receipt.receiptId,
          chain_block_height: receipt.blockHeight,
          chain_timestamp: receipt.blockTimestamp,
          metadata: JSON.parse(JSON.stringify({
            ...(typeof anchor.metadata === 'object' && anchor.metadata !== null ? anchor.metadata : {}),
            merkle_root: tree.root,
            batch_id: batchId,
          })),
          compliance_controls: getComplianceControlIds(anchor.credential_type),
        })
        .eq('id', anchor.id)
        .eq('status', 'PENDING');

      if (!updateError && updateCount === 0) {
        logger.warn({ anchorId: anchor.id }, 'Anchor already claimed — skipping legacy batch update');
        continue;
      }
      if (updateError) {
        logger.error({ anchorId: anchor.id, error: updateError }, 'Failed to update anchor in legacy batch');
        continue;
      }
      updatedCount++;
    }

    logger.info({ batchId, count: updatedCount, total: pendingAnchors.length, merkleRoot: tree.root, txId: receipt.receiptId }, 'Legacy batch anchor processing complete (fallback)');
    return { processed: updatedCount, batchId, merkleRoot: tree.root, txId: receipt.receiptId };
  }

  const processed = typeof bulkCount === 'number' ? bulkCount : pendingAnchors.length;

  logger.info(
    { batchId, count: processed, total: pendingAnchors.length, merkleRoot: tree.root, txId: receipt.receiptId },
    'Legacy batch anchor processing complete',
  );

  return { processed, batchId, merkleRoot: tree.root, txId: receipt.receiptId };
}
