/**
 * Public Record Batch Anchoring Job
 *
 * Anchors public records (EDGAR, USPTO, Federal Register) to Bitcoin via Merkle batching.
 * Processes unanchored records in large batches (10,000-100,000), builds Merkle tree,
 * submits root to chain, then stores individual proofs.
 *
 * Gated by ENABLE_PUBLIC_RECORD_ANCHORING switchboard flag.
 * Cost: ~$0.002-$0.003 per document at scale ($50-200/mo for 1M docs).
 *
 * Constitution refs:
 *   - 1.4: Treasury keys never logged
 *   - 1.9: ENABLE_PROD_NETWORK_ANCHORING gates real Bitcoin chain calls
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { getInitializedChainClient } from '../chain/client.js';
import { buildMerkleTree } from '../utils/merkle.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Max records per batch — Merkle tree performance limit */
export const PUBLIC_RECORD_BATCH_SIZE = 10_000;

/** Minimum records to trigger a batch */
export const MIN_BATCH_SIZE = 10;

export interface PublicRecordAnchorResult {
  processed: number;
  batchId: string | null;
  merkleRoot: string | null;
  txId: string | null;
}

/**
 * Process unanchored public records as a Merkle-batched Bitcoin anchor.
 *
 * Flow:
 * 1. Query public_records WHERE anchor_id IS NULL, LIMIT batch size
 * 2. Build Merkle tree from content_hash values
 * 3. Submit Merkle root to Bitcoin via single OP_RETURN transaction
 * 4. Create anchor record for the batch
 * 5. Store individual Merkle proofs in each record's metadata
 * 6. Link public_records.anchor_id to batch anchor
 */
export async function processPublicRecordAnchoring(
  supabase?: SupabaseClient,
): Promise<PublicRecordAnchorResult> {
  const client = supabase ?? db;

  // Check switchboard flag
  const { data: enabled } = await client.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORD_ANCHORING',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORD_ANCHORING is disabled — skipping');
    return { processed: 0, batchId: null, merkleRoot: null, txId: null };
  }

  // Fetch unanchored public records
  const { data: records, error: fetchError } = await client
    .from('public_records')
    .select('id, content_hash, metadata')
    .is('anchor_id', null)
    .order('created_at', { ascending: true })
    .limit(PUBLIC_RECORD_BATCH_SIZE);

  if (fetchError) {
    logger.error({ error: fetchError }, 'Failed to fetch unanchored public records');
    return { processed: 0, batchId: null, merkleRoot: null, txId: null };
  }

  if (!records || records.length < MIN_BATCH_SIZE) {
    logger.info({ count: records?.length ?? 0 }, 'Not enough unanchored records for batch');
    return { processed: 0, batchId: null, merkleRoot: null, txId: null };
  }

  const fingerprints = records.map((r) => r.content_hash);

  logger.info({ recordCount: fingerprints.length }, 'Building Merkle tree for public records batch');

  // Build Merkle tree from content hashes
  const tree = buildMerkleTree(fingerprints);

  // Submit Merkle root to Bitcoin
  let receipt;
  try {
    const chainClient = getInitializedChainClient();
    receipt = await chainClient.submitFingerprint({
      fingerprint: tree.root,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({ error, merkleRoot: tree.root }, 'Public record batch chain submission failed');
    return { processed: 0, batchId: null, merkleRoot: tree.root, txId: null };
  }

  const batchId = `pr_batch_${Date.now()}_${records.length}`;
  const txId = receipt.receiptId;

  logger.info(
    { batchId, merkleRoot: tree.root, txId, recordCount: records.length },
    'Public record batch anchored to chain',
  );

  // Create an anchor record for this batch
  const { data: anchorRecord, error: anchorError } = await client
    .from('anchors')
    .insert({
      fingerprint: tree.root,
      status: 'SUBMITTED',
      chain_tx_id: txId,
      metadata: {
        type: 'public_record_batch',
        batch_id: batchId,
        record_count: records.length,
        merkle_root: tree.root,
      },
    })
    .select('id')
    .single();

  if (anchorError || !anchorRecord) {
    logger.error({ error: anchorError, batchId }, 'Failed to create batch anchor record');
    return { processed: 0, batchId, merkleRoot: tree.root, txId };
  }

  // Update each public record with its Merkle proof + anchor_id
  let updateCount = 0;
  for (const record of records) {
    const proof = tree.proofs.get(record.content_hash);
    const existingMetadata = (record.metadata as Record<string, unknown>) ?? {};

    const { error: updateError } = await client
      .from('public_records')
      .update({
        anchor_id: anchorRecord.id,
        metadata: {
          ...existingMetadata,
          merkle_proof: proof ?? [],
          merkle_root: tree.root,
          batch_id: batchId,
          chain_tx_id: txId,
        },
      })
      .eq('id', record.id);

    if (updateError) {
      logger.error({ recordId: record.id, error: updateError }, 'Failed to update public record with proof');
    } else {
      updateCount++;
    }
  }

  logger.info(
    { batchId, processed: updateCount, total: records.length, txId },
    'Public record batch anchoring complete',
  );

  return {
    processed: updateCount,
    batchId,
    merkleRoot: tree.root,
    txId,
  };
}
