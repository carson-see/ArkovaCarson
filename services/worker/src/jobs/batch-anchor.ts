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

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { getInitializedChainClient } from '../chain/client.js';
import { buildMerkleTree } from '../utils/merkle.js';
import type { MerkleProofEntry } from '../utils/merkle.js';

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
 * Process pending anchors as a batch using a Merkle tree.
 *
 * Uses claim-before-broadcast pattern:
 * 1. Atomically claim PENDING → BROADCASTING via RPC
 * 2. Build Merkle tree from claimed anchors
 * 3. Publish Merkle root to chain
 * 4. Update each anchor: BROADCASTING → SUBMITTED with tx ID + proof
 */
export async function processBatchAnchors(): Promise<BatchAnchorResult> {
  // Phase 1: Atomically claim anchors via RPC
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: claimedAnchors, error: claimError } = await (db.rpc as any)('claim_pending_anchors', {
    p_worker_id: `batch-${process.pid}`,
    p_limit: BATCH_SIZE,
    p_exclude_pipeline: false, // Batch processing handles all anchors including pipeline
  });

  if (claimError) {
    // Fallback: legacy claim without RPC
    logger.warn({ error: claimError }, 'claim_pending_anchors RPC failed — falling back to legacy batch');
    return legacyProcessBatchAnchors();
  }

  if (!claimedAnchors || !Array.isArray(claimedAnchors) || claimedAnchors.length < MIN_BATCH_SIZE) {
    return { processed: 0, batchId: null, merkleRoot: null, txId: null };
  }

  const fingerprints = claimedAnchors.map((a: { fingerprint: string }) => a.fingerprint);

  // Phase 2: Build Merkle tree
  const tree = buildMerkleTree(fingerprints);

  // Phase 3: Publish Merkle root to chain
  let receipt;
  try {
    const chainClient = getInitializedChainClient();
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

  // Phase 4: Update each anchor: BROADCASTING → SUBMITTED
  const batchId = `batch_${Date.now()}_${claimedAnchors.length}`;
  let updatedCount = 0;

  for (const anchor of claimedAnchors) {
    const proof: MerkleProofEntry[] = tree.proofs.get(anchor.fingerprint) ?? [];

    const existingMeta = typeof anchor.metadata === 'object' && anchor.metadata !== null
      ? anchor.metadata as Record<string, unknown>
      : {};

    // Clean up claim metadata and add batch metadata
    const updatedMeta: Record<string, unknown> = { ...existingMeta };
    delete updatedMeta._claimed_by;
    delete updatedMeta._claimed_at;
    updatedMeta.merkle_proof = proof.map((p) => ({ hash: p.hash, position: p.position }));
    updatedMeta.merkle_root = tree.root;
    updatedMeta.batch_id = batchId;
    if (receipt.rawTxHex) updatedMeta._raw_tx_hex = receipt.rawTxHex;
    if (receipt.feeSats !== undefined) updatedMeta._fee_sats = receipt.feeSats;

    // RACE-1: Guard with BROADCASTING status
    const { error: updateError, count: updateCount } = await db
      .from('anchors')
      .update({
        status: 'SUBMITTED' as const,
        chain_tx_id: receipt.receiptId,
        chain_block_height: receipt.blockHeight,
        chain_timestamp: receipt.blockTimestamp,
        metadata: JSON.parse(JSON.stringify(updatedMeta)),
      })
      .eq('id', anchor.id)
      .eq('status', 'BROADCASTING');

    if (!updateError && updateCount === 0) {
      logger.warn({ anchorId: anchor.id }, 'Anchor no longer in BROADCASTING state — skipping batch update');
      continue;
    }

    if (updateError) {
      logger.error(
        { anchorId: anchor.id, error: updateError },
        'Failed to update anchor in batch',
      );
      continue;
    }

    updatedCount++;
  }

  logger.info(
    {
      batchId,
      count: updatedCount,
      total: claimedAnchors.length,
      merkleRoot: tree.root,
      txId: receipt.receiptId,
    },
    'Batch anchor processing complete',
  );

  return {
    processed: updatedCount,
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
    const chainClient = getInitializedChainClient();
    receipt = await chainClient.submitFingerprint({
      fingerprint: tree.root,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({ error, merkleRoot: tree.root }, 'Legacy batch chain submission failed');
    return { processed: 0, batchId: null, merkleRoot: tree.root, txId: null };
  }

  const batchId = `batch_${Date.now()}_${pendingAnchors.length}`;
  let updatedCount = 0;

  for (const anchor of pendingAnchors) {
    const proof: MerkleProofEntry[] = tree.proofs.get(anchor.fingerprint) ?? [];

    const { error: updateError, count: updateCount } = await db
      .from('anchors')
      .update({
        status: 'SUBMITTED' as const,
        chain_tx_id: receipt.receiptId,
        chain_block_height: receipt.blockHeight,
        chain_timestamp: receipt.blockTimestamp,
        metadata: JSON.parse(JSON.stringify({
          ...(typeof anchor.metadata === 'object' && anchor.metadata !== null ? anchor.metadata : {}),
          merkle_proof: proof.map((p) => ({ hash: p.hash, position: p.position })),
          merkle_root: tree.root,
          batch_id: batchId,
          ...(receipt.rawTxHex ? { _raw_tx_hex: receipt.rawTxHex } : {}),
          ...(receipt.feeSats !== undefined ? { _fee_sats: receipt.feeSats } : {}),
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

  return { processed: updatedCount, batchId, merkleRoot: tree.root, txId: receipt.receiptId };
}
