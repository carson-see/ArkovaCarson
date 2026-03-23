/**
 * Batch Anchor Processing Job (MVP-23)
 *
 * Processes batches of anchors by combining fingerprints into a
 * Merkle tree and publishing the root as a single Bitcoin transaction.
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

/** Max anchors per batch transaction */
export const BATCH_SIZE = 50;

/** Minimum anchors required for batch processing (otherwise use individual) */
export const MIN_BATCH_SIZE = 2;

export interface BatchAnchorResult {
  processed: number;
  batchId: string | null;
  merkleRoot: string | null;
  txId: string | null;
}

/**
 * Process pending anchors as a batch using a Merkle tree.
 *
 * Combines fingerprints into a single Merkle root, publishes that root
 * as one chain transaction, then updates each anchor with the tx ID
 * and its individual Merkle proof (stored in metadata).
 */
export async function processBatchAnchors(): Promise<BatchAnchorResult> {
  // Fetch pending anchors eligible for batch processing
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
    // Not enough for batch — let individual processing handle it
    return { processed: 0, batchId: null, merkleRoot: null, txId: null };
  }

  const fingerprints = pendingAnchors.map((a) => a.fingerprint);

  // Build Merkle tree
  const tree = buildMerkleTree(fingerprints);

  // Publish Merkle root to chain as a single transaction
  let receipt;
  try {
    const chainClient = getInitializedChainClient();
    receipt = await chainClient.submitFingerprint({
      fingerprint: tree.root,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({ error, merkleRoot: tree.root }, 'Batch anchor chain submission failed');
    return { processed: 0, batchId: null, merkleRoot: tree.root, txId: null };
  }

  // Generate a batch ID
  const batchId = `batch_${Date.now()}_${pendingAnchors.length}`;

  // Update each anchor with chain info + Merkle proof
  let updatedCount = 0;
  for (const anchor of pendingAnchors) {
    const proof: MerkleProofEntry[] = tree.proofs.get(anchor.fingerprint) ?? [];

    // Set to SUBMITTED (not SECURED) — the check-confirmations cron will
    // promote to SECURED once the batch tx is confirmed on chain.
    // This matches the standard anchor.ts lifecycle (TLA review finding #5).
    // RACE-1 fix: Add status guard to prevent double-broadcast in concurrent workers
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
        })),
      })
      .eq('id', anchor.id)
      .eq('status', 'PENDING');

    if (!updateError && updateCount === 0) {
      logger.warn({ anchorId: anchor.id }, 'Anchor already claimed by another worker — skipping batch update');
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
      total: pendingAnchors.length,
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
