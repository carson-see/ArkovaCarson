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

/**
 * Max anchors per batch transaction — configurable via BATCH_ANCHOR_MAX_SIZE env (BTC-001).
 * Default: 100. Range: 1–10,000.
 */
export const BATCH_SIZE = Math.min(
  Math.max(parseInt(process.env.BATCH_ANCHOR_MAX_SIZE ?? '100', 10) || 100, 1),
  10000,
);

/**
 * INEFF-2: Minimum anchors required for batch processing.
 * Lowered from 2 to 1 so ALL anchors benefit from Merkle batching.
 */
export const MIN_BATCH_SIZE = 1;

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
 * Process pending anchors as a batch using a Merkle tree.
 *
 * Uses claim-before-broadcast pattern:
 * 1. Atomically claim PENDING → BROADCASTING via RPC (chunked to avoid PostgREST 1000-row cap)
 * 2. Build Merkle tree from claimed anchors
 * 3. Publish Merkle root to chain
 * 4. Update each anchor: BROADCASTING → SUBMITTED with tx ID + proof
 */
export async function processBatchAnchors(): Promise<BatchAnchorResult> {
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
    logger.error({ error, merkleRoot: tree.root }, 'Batch anchor chain submission failed — reverting claims');
    // Revert all claimed anchors back to PENDING
    for (const anchor of claimedAnchors) {
      await revertBatchAnchorToPending(anchor.id);
    }
    return { processed: 0, batchId: null, merkleRoot: tree.root, txId: null };
  }

  if (!receipt || !receipt.receiptId) {
    logger.error({ merkleRoot: tree.root }, 'Batch chain broadcast returned empty receipt — reverting claims');
    for (const anchor of claimedAnchors) {
      await revertBatchAnchorToPending(anchor.id);
    }
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
    // Fallback: try individual updates if RPC fails
    logger.warn({ error: bulkError }, 'submit_batch_anchors RPC failed — falling back to individual updates');
    let fallbackCount = 0;
    for (const anchor of claimedAnchors) {
      const { error: updateError } = await db
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
        })
        .eq('id', anchor.id)
        .eq('status', 'BROADCASTING');

      if (!updateError) fallbackCount++;
    }

    logger.info({ batchId, count: fallbackCount, total: claimedAnchors.length, merkleRoot: tree.root, txId: receipt.receiptId }, 'Batch anchor processing complete (fallback)');
    return { processed: fallbackCount, batchId, merkleRoot: tree.root, txId: receipt.receiptId };
  }

  const processed = typeof updatedCount === 'number' ? updatedCount : (claimedAnchors.length);

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
 * Legacy fallback: batch processing without claim RPC.
 * Used when migration 0111 hasn't been applied yet.
 */
async function legacyProcessBatchAnchors(): Promise<BatchAnchorResult> {
  const { data: pendingAnchors, error: fetchError } = await db
    .from('anchors')
    .select('id, fingerprint, metadata')
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
