/**
 * Attestation Anchoring Job
 *
 * Anchors PENDING attestations to Bitcoin via Merkle batching.
 * Each attestation's fingerprint is included in a Merkle tree,
 * and the root is submitted as an OP_RETURN transaction.
 *
 * Flow:
 * 1. Fetch attestations with status = 'PENDING' and non-null fingerprint
 * 2. Build Merkle tree from fingerprints
 * 3. Submit Merkle root to Bitcoin
 * 4. Update attestations: PENDING → ACTIVE with chain_tx_id, chain_timestamp
 *
 * Gated by ENABLE_ATTESTATION_ANCHORING switchboard flag.
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
import { callRpc } from '../utils/rpc.js';

/** Max attestations per batch */
export const ATTESTATION_BATCH_SIZE = 100;

export interface AttestationAnchorResult {
  processed: number;
  skipped: number;
  batchId: string | null;
  merkleRoot: string | null;
  txId: string | null;
}

interface AttestationRow {
  id: string;
  public_id: string;
  fingerprint: string;
}

/**
 * Process PENDING attestations: Merkle-batch their fingerprints to Bitcoin.
 */
export async function processAttestationAnchoring(
  supabase?: SupabaseClient,
): Promise<AttestationAnchorResult> {
  const client = supabase ?? db;
  const emptyResult: AttestationAnchorResult = { processed: 0, skipped: 0, batchId: null, merkleRoot: null, txId: null };

  // Check switchboard flag
  const { data: enabled } = await callRpc(client, 'get_flag', {
    p_flag_key: 'ENABLE_ATTESTATION_ANCHORING',
  });
  if (!enabled) {
    logger.info('ENABLE_ATTESTATION_ANCHORING is disabled — skipping');
    return emptyResult;
  }

  // Fetch PENDING attestations that have fingerprints
  const { data: attestations, error: fetchError } = await client
    .from('attestations')
    .select('id, public_id, fingerprint')
    .eq('status', 'PENDING')
    .not('fingerprint', 'is', null)
    .order('created_at', { ascending: true })
    .limit(ATTESTATION_BATCH_SIZE);

  if (fetchError) {
    logger.error({ error: fetchError }, 'Failed to fetch pending attestations');
    return emptyResult;
  }

  const rows = (attestations ?? []) as AttestationRow[];
  if (rows.length === 0) {
    logger.info('No pending attestations to anchor');
    return emptyResult;
  }

  logger.info({ count: rows.length }, 'Anchoring pending attestations');

  // Build Merkle tree from attestation fingerprints
  const fingerprints = rows.map((a) => a.fingerprint);
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
    logger.error({ error, merkleRoot: tree.root, count: rows.length }, 'Attestation batch chain submission failed');
    return { ...emptyResult, merkleRoot: tree.root };
  }

  const batchId = `att_batch_${Date.now()}_${rows.length}`;
  const txId = receipt.receiptId;
  const now = new Date().toISOString();

  logger.info(
    { batchId, merkleRoot: tree.root, txId, count: rows.length },
    'Attestation Merkle root anchored to chain',
  );

  // Update each attestation: PENDING → ACTIVE with chain proof data
  let updateCount = 0;
  let skippedCount = 0;

  for (const att of rows) {
    const proof = tree.proofs.get(att.fingerprint);

    const { data: updated, error: updateError } = await client
      .from('attestations')
      .update({
        status: 'ACTIVE',
        chain_tx_id: txId,
        chain_timestamp: now,
        metadata: {
          merkle_proof: proof ?? [],
          merkle_root: tree.root,
          batch_id: batchId,
        },
      })
      .eq('id', att.id)
      .eq('status', 'PENDING') // Optimistic lock — only update if still PENDING
      .select('id');

    if (updateError) {
      logger.error({ attestationId: att.id, error: updateError }, 'Failed to update attestation with chain data');
      continue;
    }

    // Check if update actually matched a row (race condition detection)
    if (!updated || (updated as unknown[]).length === 0) {
      logger.warn({ attestationId: att.id }, 'Attestation status changed during anchoring — skipping');
      skippedCount++;
      continue;
    }

    updateCount++;
  }

  logger.info(
    { batchId, processed: updateCount, skipped: skippedCount, txId },
    'Attestation anchoring complete',
  );

  return {
    processed: updateCount,
    skipped: skippedCount,
    batchId,
    merkleRoot: tree.root,
    txId,
  };
}
