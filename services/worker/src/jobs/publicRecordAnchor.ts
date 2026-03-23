/**
 * Public Record Anchoring Job
 *
 * Creates individual anchor records for each public record (EDGAR, USPTO, etc.),
 * then Merkle-batches their fingerprints into a single Bitcoin OP_RETURN transaction.
 * Each document gets its own anchor visible in Treasury with its own fingerprint.
 *
 * Flow:
 * 1. Resolve platform admin user_id (carson@arkova.ai) for anchor ownership
 * 2. Fetch unanchored public_records
 * 3. Create individual anchor records (status: PENDING) for each
 * 4. Build Merkle tree from all fingerprints
 * 5. Submit Merkle root to Bitcoin
 * 6. Update all anchors to SUBMITTED with chain tx_id and Merkle proofs
 * 7. Link public_records.anchor_id to their individual anchors
 *
 * Gated by ENABLE_PUBLIC_RECORD_ANCHORING switchboard flag.
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

/** Max records per batch — Merkle tree handles thousands efficiently.
 * Increased from 2,000 to 2,500 per audit recommendation. Monitor performance. */
export const PUBLIC_RECORD_BATCH_SIZE = 2500;

/** Minimum records to trigger a batch */
export const MIN_BATCH_SIZE = 1;

/** Platform admin email — pipeline anchors are owned by this account */
const PIPELINE_OWNER_EMAIL = 'carson@arkova.ai';

export interface PublicRecordAnchorResult {
  processed: number;
  anchorsCreated: number;
  batchId: string | null;
  merkleRoot: string | null;
  txId: string | null;
}

/**
 * Map public record source/type to a display-friendly filename for the anchor.
 */
function buildAnchorFilename(record: {
  source: string;
  source_id: string;
  title: string | null;
  record_type: string;
}): string {
  const prefix = record.source === 'edgar'
    ? 'SEC'
    : record.source === 'openalex'
      ? 'OA'
      : record.source === 'uspto'
        ? 'USPTO'
        : record.source === 'federal_register'
          ? 'FR'
          : record.source.toUpperCase();

  // Use title if available, otherwise source_id
  const name = record.title
    ? record.title.slice(0, 180)
    : `${record.record_type}-${record.source_id}`;

  return `[${prefix}] ${name}`;
}

/**
 * Map public record source to credential_type enum.
 * Pipeline records use dedicated types added in migration 0091.
 */
function mapCredentialType(source: string): string {
  switch (source) {
    case 'edgar': return 'SEC_FILING';
    case 'uspto': return 'PATENT';
    case 'openalex': return 'PUBLICATION';
    case 'federal_register': return 'REGULATION';
    default: return 'OTHER';
  }
}

/**
 * Process unanchored public records: create individual anchors + Merkle-batch to chain.
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
    return { processed: 0, anchorsCreated: 0, batchId: null, merkleRoot: null, txId: null };
  }

  // Resolve platform admin user_id for anchor ownership
  const { data: adminProfile, error: adminError } = await client
    .from('profiles')
    .select('id, org_id')
    .eq('email', PIPELINE_OWNER_EMAIL)
    .single();

  if (adminError || !adminProfile) {
    logger.error({ error: adminError }, `Platform admin ${PIPELINE_OWNER_EMAIL} not found — cannot create anchors`);
    return { processed: 0, anchorsCreated: 0, batchId: null, merkleRoot: null, txId: null };
  }

  const ownerId = adminProfile.id as string;
  const ownerOrgId = (adminProfile.org_id as string) ?? null;

  // Fetch unanchored public records
  const { data: records, error: fetchError } = await client
    .from('public_records')
    .select('id, source, source_id, source_url, record_type, title, content_hash, metadata')
    .is('anchor_id', null)
    .order('created_at', { ascending: true })
    .limit(PUBLIC_RECORD_BATCH_SIZE);

  if (fetchError) {
    logger.error({ error: fetchError }, 'Failed to fetch unanchored public records');
    return { processed: 0, anchorsCreated: 0, batchId: null, merkleRoot: null, txId: null };
  }

  if (!records || records.length < MIN_BATCH_SIZE) {
    logger.info({ count: records?.length ?? 0 }, 'No unanchored records to process');
    return { processed: 0, anchorsCreated: 0, batchId: null, merkleRoot: null, txId: null };
  }

  logger.info({ recordCount: records.length }, 'Creating individual anchors for public records');

  // Step 1: Create individual anchor records for each public record
  const anchorInserts = records.map((r) => ({
    user_id: ownerId,
    org_id: ownerOrgId,
    fingerprint: r.content_hash,
    filename: buildAnchorFilename(r),
    credential_type: mapCredentialType(r.source),
    status: 'PENDING' as const,
    metadata: {
      pipeline_source: r.source,
      source_id: r.source_id,
      source_url: r.source_url,
      record_type: r.record_type,
    },
  }));

  // Insert individually, skipping duplicates (partial unique index prevents upsert)
  const createdAnchors: Array<{ id: string; fingerprint: string }> = [];

  for (const anchor of anchorInserts) {
    const { data: inserted, error: insertError } = await client
      .from('anchors')
      .insert(anchor)
      .select('id, fingerprint')
      .single();

    if (insertError) {
      // 23505 = unique_violation — record already anchored, skip
      if (insertError.code === '23505') {
        // Look up existing anchor to link the public record
        const { data: existing } = await client
          .from('anchors')
          .select('id, fingerprint')
          .eq('user_id', ownerId)
          .eq('fingerprint', anchor.fingerprint)
          .is('deleted_at', null)
          .single();
        if (existing) {
          createdAnchors.push(existing as { id: string; fingerprint: string });
        }
        continue;
      }
      logger.error({ error: insertError, fingerprint: anchor.fingerprint }, 'Failed to create anchor');
      continue;
    }

    if (inserted) {
      createdAnchors.push(inserted as { id: string; fingerprint: string });
    }
  }

  logger.info({ created: createdAnchors.length, total: records.length }, 'Anchor records created');

  if (createdAnchors.length === 0) {
    logger.warn('No new anchors created (all may be duplicates)');
    return { processed: 0, anchorsCreated: 0, batchId: null, merkleRoot: null, txId: null };
  }

  // Step 2: Link public_records.anchor_id FIRST (even before chain submission)
  // This ensures records are linked to their anchors regardless of chain status
  let linkCount = 0;
  const anchorByFingerprint = new Map(createdAnchors.map((a) => [a.fingerprint, a.id]));

  for (const record of records) {
    const anchorId = anchorByFingerprint.get(record.content_hash);
    if (!anchorId) continue;

    const { error: linkError } = await client
      .from('public_records')
      .update({ anchor_id: anchorId })
      .eq('id', record.id)
      .is('anchor_id', null);

    if (!linkError) {
      linkCount++;
    }
  }

  logger.info({ linked: linkCount, total: records.length }, 'Public records linked to anchors');

  // Step 3: Build Merkle tree from all fingerprints in this batch
  const fingerprints = createdAnchors.map((a) => a.fingerprint);
  const tree = buildMerkleTree(fingerprints);

  // Step 4: Submit Merkle root to Bitcoin
  let receipt;
  try {
    const chainClient = getInitializedChainClient();
    receipt = await chainClient.submitFingerprint({
      fingerprint: tree.root,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({ error, merkleRoot: tree.root }, 'Public record batch chain submission failed');
    // Anchors stay PENDING — chain submission will be retried on next run
    return { processed: linkCount, anchorsCreated: createdAnchors.length, batchId: null, merkleRoot: tree.root, txId: null };
  }

  const batchId = `pr_batch_${Date.now()}_${createdAnchors.length}`;
  const txId = receipt.receiptId;

  logger.info(
    { batchId, merkleRoot: tree.root, txId, anchorCount: createdAnchors.length },
    'Merkle root anchored to chain',
  );

  // Step 5: Update each anchor with chain tx and Merkle proof, set status SUBMITTED
  let updateCount = 0;

  for (const record of records) {
    const anchorId = anchorByFingerprint.get(record.content_hash);
    if (!anchorId) continue;

    const proof = tree.proofs.get(record.content_hash);

    // Update anchor: PENDING → SUBMITTED with chain data
    const { error: anchorUpdateError } = await client
      .from('anchors')
      .update({
        status: 'SUBMITTED',
        chain_tx_id: txId,
        metadata: {
          pipeline_source: record.source,
          source_id: record.source_id,
          source_url: record.source_url,
          record_type: record.record_type,
          merkle_proof: proof ?? [],
          merkle_root: tree.root,
          batch_id: batchId,
        },
      })
      .eq('id', anchorId);

    if (anchorUpdateError) {
      logger.error({ anchorId, error: anchorUpdateError }, 'Failed to update anchor with chain data');
      continue;
    }

    // Update public_record metadata with Merkle proof info
    const existingMetadata = (record.metadata as Record<string, unknown>) ?? {};
    const { error: recordUpdateError } = await client
      .from('public_records')
      .update({
        metadata: {
          ...existingMetadata,
          merkle_proof: proof ?? [],
          merkle_root: tree.root,
          batch_id: batchId,
          chain_tx_id: txId,
        },
      })
      .eq('id', record.id);

    if (recordUpdateError) {
      logger.error({ recordId: record.id, error: recordUpdateError }, 'Failed to update public record metadata');
    } else {
      updateCount++;
    }
  }

  logger.info(
    { batchId, processed: updateCount, anchorsCreated: createdAnchors.length, txId },
    'Public record anchoring complete — individual anchors visible in Treasury',
  );

  return {
    processed: updateCount,
    anchorsCreated: createdAnchors.length,
    batchId,
    merkleRoot: tree.root,
    txId,
  };
}
