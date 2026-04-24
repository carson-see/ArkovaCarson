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
import { getChainClientAsync } from '../chain/client.js';
import { buildMerkleTree } from '../utils/merkle.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { upsertAnchorProofs } from '../utils/anchorProofs.js';
import { POSTGREST_ROW_LIMIT, resolveAnchorBatchSize } from './anchor-batching.js';

/** Max records per batch — one Bitcoin TX can commit up to 10k pipeline anchors. */
export const PUBLIC_RECORD_BATCH_SIZE = resolveAnchorBatchSize(config.batchAnchorMaxSize);

/** Minimum records to trigger a batch */
export const MIN_BATCH_SIZE = 1;

/** Keep JSON RPC payloads comfortably below gateway limits. */
const ANCHOR_INSERT_CHUNK = 1_000;
const FINALIZE_RPC_CHUNK = 500;

/** Platform admin email — pipeline anchors are owned by this account */
const PIPELINE_OWNER_EMAIL = 'carson@arkova.ai';

export interface PublicRecordAnchorResult {
  processed: number;
  anchorsCreated: number;
  batchId: string | null;
  merkleRoot: string | null;
  txId: string | null;
  alreadyAnchored?: number;
  claimed?: number;
}

interface PipelinePublicRecord {
  id: string;
  source: string;
  source_id: string;
  source_url: string | null;
  record_type: string;
  title: string | null;
  content_hash: string;
  metadata: Record<string, unknown>;
}

interface PipelineAnchorRow {
  id: string;
  fingerprint: string;
  status: string;
  chain_tx_id: string | null;
  metadata?: Record<string, unknown> | null;
}

interface RecordAnchorItem {
  record_id: string;
  anchor_id: string;
}

interface FinalizeRecordAnchorItem extends RecordAnchorItem {
  merkle_proof: unknown;
}

let publicRecordAnchoringRunning = false;

/**
 * Map public record source/type to a display-friendly filename for the anchor.
 */
/** Source → display prefix for anchor filenames */
const SOURCE_PREFIX: Record<string, string> = {
  edgar: 'SEC',
  openalex: 'OA',
  uspto: 'USPTO',
  federal_register: 'FR',
  courtlistener: 'CASE',
  npi: 'NPI',
  finra: 'FINRA',
  dapip: 'DAPIP',
  calbar: 'CALBAR',
  sec_iapd: 'IAPD',
  acnc: 'ACNC',
  fcc: 'FCC',
  openstates: 'BILL',
  sam_gov: 'SAM',
  sam_gov_exclusions: 'SAM-EX',
  // NPH-05–10 sources
  sos_de: 'DE-SOS',
  sos_ca: 'CA-SOS',
  sos_ny: 'NY-SOS',
  sos_tx: 'TX-SOS',
  ipeds: 'IPEDS',
  insurance_ca_cdi: 'CA-INS',
  cle_ny: 'NY-CLE',
  cle_tx: 'TX-CLE',
  cert_cfa: 'CFA',
  cert_comptia: 'COMPTIA',
  cert_pmi: 'PMI',
};

export function buildAnchorFilename(record: {
  source: string;
  source_id: string;
  title: string | null;
  record_type: string;
}): string {
  const prefix = SOURCE_PREFIX[record.source] ?? record.source.toUpperCase();

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
export function mapCredentialType(source: string): string {
  switch (source) {
    // Original pipeline sources (migration 0091)
    case 'edgar': return 'SEC_FILING';
    case 'uspto': return 'PATENT';
    case 'openalex': return 'PUBLICATION';
    case 'federal_register': return 'REGULATION';
    case 'courtlistener': return 'LEGAL';
    // NPH-01: Fix misclassified sources that were falling through to OTHER
    case 'npi': return 'MEDICAL';
    case 'finra': return 'FINANCIAL';
    case 'sec_iapd': return 'FINANCIAL';
    case 'dapip': return 'ACCREDITATION';
    case 'calbar': return 'LICENSE';
    case 'acnc': return 'CHARITY';
    case 'fcc': return 'LICENSE';
    case 'openstates': return 'REGULATION';
    case 'sam_gov': return 'CERTIFICATE';
    case 'sam_gov_exclusions': return 'CERTIFICATE';
    // NPH-05–10: New pipeline sources
    case 'sos_de': case 'sos_ca': case 'sos_ny': case 'sos_tx': return 'BUSINESS_ENTITY';
    case 'ipeds': return 'ACCREDITATION';
    case 'insurance_ca_cdi': return 'INSURANCE';
    case 'cle_ny': case 'cle_tx': return 'CLE';
    case 'cert_cfa': case 'cert_comptia': case 'cert_pmi': return 'CERTIFICATE';
    default: {
      // License board sources follow pattern: license_{state}_{board}
      if (source.startsWith('license_')) return 'LICENSE';
      return 'OTHER';
    }
  }
}

function isBitcoinAnchored(anchor: PipelineAnchorRow): boolean {
  return (
    (anchor.status === 'SUBMITTED' || anchor.status === 'SECURED') &&
    Boolean(anchor.chain_tx_id)
  );
}

function uniqueById<T extends { id: string }>(rows: T[]): T[] {
  return Array.from(new Map(rows.map((row) => [row.id, row])).values());
}

async function fetchAnchorRows(
  client: SupabaseClient,
  anchorIds: string[],
): Promise<PipelineAnchorRow[]> {
  const rows: PipelineAnchorRow[] = [];
  const ids = Array.from(new Set(anchorIds));

  for (let i = 0; i < ids.length; i += POSTGREST_ROW_LIMIT) {
    const chunk = ids.slice(i, i + POSTGREST_ROW_LIMIT);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (client as any)
      .from('anchors')
      .select('id, fingerprint, status, chain_tx_id, metadata')
      .in('id', chunk)
      .is('deleted_at', null);

    if (error) {
      logger.error({ error, chunkStart: i, chunkSize: chunk.length }, 'Failed to fetch anchor rows after insert');
      continue;
    }

    rows.push(...((data ?? []) as PipelineAnchorRow[]));
  }

  return rows;
}

async function claimPendingPipelineAnchors(
  client: SupabaseClient,
  anchors: PipelineAnchorRow[],
): Promise<PipelineAnchorRow[]> {
  const claimed: PipelineAnchorRow[] = [];
  const uniqueAnchors = uniqueById(anchors);

  for (let i = 0; i < uniqueAnchors.length; i += POSTGREST_ROW_LIMIT) {
    const chunk = uniqueAnchors.slice(i, i + POSTGREST_ROW_LIMIT);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (client as any)
      .from('anchors')
      .update({ status: 'BROADCASTING' })
      .in('id', chunk.map((a) => a.id))
      .eq('status', 'PENDING')
      .select('id, fingerprint, status, chain_tx_id, metadata');

    if (error) {
      logger.error({ error, chunkStart: i, chunkSize: chunk.length }, 'Failed to claim pipeline anchors');
      continue;
    }

    claimed.push(...((data ?? []) as PipelineAnchorRow[]));
  }

  return claimed;
}

async function revertClaimedAnchors(
  client: SupabaseClient,
  anchorIds: string[],
): Promise<void> {
  for (let i = 0; i < anchorIds.length; i += POSTGREST_ROW_LIMIT) {
    const chunk = anchorIds.slice(i, i + POSTGREST_ROW_LIMIT);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (client as any)
      .from('anchors')
      .update({ status: 'PENDING' })
      .in('id', chunk)
      .eq('status', 'BROADCASTING');

    if (error) {
      logger.error({ error, chunkStart: i, chunkSize: chunk.length }, 'Failed to revert claimed pipeline anchors');
    }
  }
}

async function linkExistingPublicRecordAnchors(
  client: SupabaseClient,
  items: RecordAnchorItem[],
): Promise<number> {
  let linked = 0;
  for (let i = 0; i < items.length; i += FINALIZE_RPC_CHUNK) {
    const chunk = items.slice(i, i + FINALIZE_RPC_CHUNK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (client.rpc as any)('link_public_records_to_anchors', {
      p_items: chunk,
    });

    if (error) {
      logger.error({ error, chunkStart: i, chunkSize: chunk.length }, 'Failed to link existing public record anchors');
      continue;
    }

    linked += Number((data as { records_updated?: number } | null)?.records_updated ?? 0);
  }
  return linked;
}

async function finalizePublicRecordAnchorBatch(
  client: SupabaseClient,
  items: FinalizeRecordAnchorItem[],
  receipt: { receiptId: string; blockHeight?: number | null; blockTimestamp?: string | null },
  merkleRoot: string,
  batchId: string,
): Promise<{ recordsUpdated: number; anchorsUpdated: number }> {
  let recordsUpdated = 0;
  let anchorsUpdated = 0;

  for (let i = 0; i < items.length; i += FINALIZE_RPC_CHUNK) {
    const chunk = items.slice(i, i + FINALIZE_RPC_CHUNK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (client.rpc as any)('finalize_public_record_anchor_batch', {
      p_items: chunk,
      p_tx_id: receipt.receiptId,
      p_block_height: receipt.blockHeight ?? null,
      p_block_timestamp: receipt.blockTimestamp ?? null,
      p_merkle_root: merkleRoot,
      p_batch_id: batchId,
    });

    if (error) {
      logger.error({ error, chunkStart: i, chunkSize: chunk.length, batchId }, 'Failed to finalize public record anchor chunk');
      continue;
    }

    recordsUpdated += Number((data as { records_updated?: number } | null)?.records_updated ?? 0);
    anchorsUpdated += Number((data as { anchors_updated?: number } | null)?.anchors_updated ?? 0);

    try {
      await upsertAnchorProofs(
        client,
        chunk.map((item) => ({
          anchorId: item.anchor_id,
          receiptId: receipt.receiptId,
          blockHeight: receipt.blockHeight ?? null,
          blockTimestamp: receipt.blockTimestamp ?? null,
          merkleRoot,
          proofPath: item.merkle_proof,
          batchId,
        })),
      );
    } catch (proofError) {
      logger.warn(
        { error: proofError, chunkStart: i, chunkSize: chunk.length, batchId },
        'Failed to persist public record Merkle proofs',
      );
    }
  }

  return { recordsUpdated, anchorsUpdated };
}

/**
 * Process unanchored public records: create individual anchors + Merkle-batch to chain.
 */
export async function processPublicRecordAnchoring(
  supabase?: SupabaseClient,
): Promise<PublicRecordAnchorResult> {
  const empty: PublicRecordAnchorResult = {
    processed: 0,
    anchorsCreated: 0,
    batchId: null,
    merkleRoot: null,
    txId: null,
  };
  if (publicRecordAnchoringRunning) {
    logger.info('Public record anchoring skipped — already in progress');
    return empty;
  }
  publicRecordAnchoringRunning = true;
  try {
    return await processPublicRecordAnchoringInner(supabase);
  } finally {
    publicRecordAnchoringRunning = false;
  }
}

async function processPublicRecordAnchoringInner(
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

  // Fetch unanchored public records in chunks (PostgREST caps at 1000 rows per request)
  // Prioritize compliance sources: courtlistener, edgar, federal_register first
  const PRIORITY_SOURCES = ['courtlistener', 'edgar', 'federal_register', 'dapip'];
  const records: PipelinePublicRecord[] = [];

  // Phase 1: Fetch priority compliance sources first
  for (const prioritySource of PRIORITY_SOURCES) {
    if (records.length >= PUBLIC_RECORD_BATCH_SIZE) break;
    const remaining = PUBLIC_RECORD_BATCH_SIZE - records.length;

    for (let offset = 0; offset < remaining; offset += POSTGREST_ROW_LIMIT) {
      const chunkSize = Math.min(POSTGREST_ROW_LIMIT, remaining - offset);
      const { data: chunk, error: chunkError } = await client
        .from('public_records')
        .select('id, source, source_id, source_url, record_type, title, content_hash, metadata')
        .is('anchor_id', null)
        .eq('source', prioritySource)
        .order('created_at', { ascending: true })
        .range(offset, offset + chunkSize - 1);

      if (chunkError) {
        logger.error({ error: chunkError, offset, source: prioritySource }, 'Failed to fetch priority records chunk');
        break;
      }
      if (!chunk || chunk.length === 0) break;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      records.push(...(chunk as any));
      if (chunk.length < chunkSize) break;
    }
  }

  // Phase 2: Fill remaining capacity with any other unconverted records
  if (records.length < PUBLIC_RECORD_BATCH_SIZE) {
    const remaining = PUBLIC_RECORD_BATCH_SIZE - records.length;

    for (let offset = 0; offset < remaining; offset += POSTGREST_ROW_LIMIT) {
      const chunkSize = Math.min(POSTGREST_ROW_LIMIT, remaining - offset);
      const { data: chunk, error: chunkError } = await client
        .from('public_records')
        .select('id, source, source_id, source_url, record_type, title, content_hash, metadata')
        .is('anchor_id', null)
        .not('source', 'in', `(${PRIORITY_SOURCES.join(',')})`)
        .order('created_at', { ascending: true })
        .range(offset, offset + chunkSize - 1);

      if (chunkError) {
        logger.error({ error: chunkError, offset }, 'Failed to fetch remaining records chunk');
        break;
      }
      if (!chunk || chunk.length === 0) break;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      records.push(...(chunk as any));
      if (chunk.length < chunkSize) break;
    }
  }
  const fetchError: Error | null = null;

  if (fetchError) {
    logger.error({ error: fetchError }, 'Failed to fetch unanchored public records');
    return { processed: 0, anchorsCreated: 0, batchId: null, merkleRoot: null, txId: null };
  }

  if (!records || records.length < MIN_BATCH_SIZE) {
    logger.info({ count: records?.length ?? 0 }, 'No unanchored records to process');
    return { processed: 0, anchorsCreated: 0, batchId: null, merkleRoot: null, txId: null };
  }

  const batchStartTime = Date.now();
  const heapBefore = process.memoryUsage().heapUsed;
  logger.info({ recordCount: records.length, batchSize: PUBLIC_RECORD_BATCH_SIZE }, 'Creating individual anchors for public records');

  // Step 1: Create individual anchor records for each public record
  const anchorInserts = records.map((r) => {
    // Pull description from public record metadata (abstract, description, summary)
    const meta = r.metadata ?? {};
    const description = (
      (typeof meta.abstract === 'string' ? meta.abstract : null)
      ?? (typeof meta.description === 'string' ? meta.description : null)
      ?? (typeof meta.summary === 'string' ? meta.summary : null)
    )?.slice(0, 500) ?? null;

    return {
      user_id: ownerId,
      org_id: ownerOrgId,
      fingerprint: r.content_hash,
      filename: buildAnchorFilename(r),
      credential_type: mapCredentialType(r.source),
      status: 'PENDING' as const,
      ...(description ? { description } : {}),
      metadata: {
        pipeline_source: r.source,
        source_id: r.source_id,
        source_url: r.source_url,
        record_type: r.record_type,
      },
    };
  });

  // Batch insert via server-side RPC — handles partial unique index ON CONFLICT.
  const createdAnchors: Array<{ id: string; fingerprint: string }> = [];

  for (let i = 0; i < anchorInserts.length; i += ANCHOR_INSERT_CHUNK) {
    const chunk = anchorInserts.slice(i, i + ANCHOR_INSERT_CHUNK);
    const { data: result, error: rpcError } = await client.rpc('batch_insert_anchors', {
      p_anchors: chunk,
    });

    if (rpcError) {
      logger.error({ error: rpcError, chunkIndex: i, chunkSize: chunk.length }, 'Batch insert RPC failed — falling back to serial inserts');
      // Fallback: serial insert for this chunk only
      for (const anchor of chunk) {
        const { data: inserted, error: insertError } = await client
          .from('anchors')
          .insert(anchor)
          .select('id, fingerprint')
          .single();

        if (insertError) {
          if (insertError.code === '23505') {
            const { data: existing } = await client
              .from('anchors')
              .select('id, fingerprint')
              .eq('user_id', ownerId)
              .eq('fingerprint', anchor.fingerprint)
              .is('deleted_at', null)
              .single();
            if (existing) createdAnchors.push(existing as { id: string; fingerprint: string });
            continue;
          }
          logger.error({ error: insertError, fingerprint: anchor.fingerprint }, 'Failed to create anchor');
          continue;
        }
        if (inserted) createdAnchors.push(inserted as { id: string; fingerprint: string });
      }
      continue;
    }

    // RPC returns jsonb array of {id, fingerprint}
    const anchors = (result ?? []) as Array<{ id: string; fingerprint: string }>;
    createdAnchors.push(...anchors);
    logger.info({ chunk: Math.floor(i / ANCHOR_INSERT_CHUNK) + 1, inserted: anchors.length }, 'Batch insert chunk complete');
  }

  logger.info({ created: createdAnchors.length, total: records.length }, 'Anchor records created (batch RPC)');

  if (createdAnchors.length === 0) {
    logger.warn('No new anchors created (all may be duplicates)');
    return { processed: 0, anchorsCreated: 0, batchId: null, merkleRoot: null, txId: null };
  }

  // Step 2: Resolve anchor status. Already-submitted duplicate records can be
  // linked without burning another Bitcoin transaction.
  const anchorRows = await fetchAnchorRows(client, createdAnchors.map((a) => a.id));
  const anchorByFingerprint = new Map(anchorRows.map((a) => [a.fingerprint, a]));
  const alreadyAnchoredItems: RecordAnchorItem[] = [];
  const pendingRecordItems: Array<{ record: PipelinePublicRecord; anchor: PipelineAnchorRow }> = [];

  for (const record of records) {
    const anchor = anchorByFingerprint.get(record.content_hash);
    if (!anchor) continue;

    if (isBitcoinAnchored(anchor)) {
      alreadyAnchoredItems.push({ record_id: record.id, anchor_id: anchor.id });
    } else if (anchor.status === 'PENDING') {
      pendingRecordItems.push({ record, anchor });
    }
  }

  const alreadyAnchored = await linkExistingPublicRecordAnchors(client, alreadyAnchoredItems);
  if (alreadyAnchored > 0) {
    logger.info({ linked: alreadyAnchored }, 'Linked public records to existing Bitcoin anchors');
  }

  if (pendingRecordItems.length === 0) {
    logger.info({ alreadyAnchored, total: records.length }, 'No new pending public record anchors to submit');
    return {
      processed: alreadyAnchored,
      anchorsCreated: createdAnchors.length,
      batchId: null,
      merkleRoot: null,
      txId: null,
      alreadyAnchored,
      claimed: 0,
    };
  }

  // Step 3: Claim PENDING anchors before broadcast so a concurrent batch job
  // cannot publish the same fingerprints in a second transaction.
  const claimedAnchors = await claimPendingPipelineAnchors(
    client,
    pendingRecordItems.map((item) => item.anchor),
  );
  const claimedById = new Map(claimedAnchors.map((a) => [a.id, a]));
  const claimedRecordItems = pendingRecordItems.filter((item) => claimedById.has(item.anchor.id));

  if (claimedAnchors.length === 0 || claimedRecordItems.length === 0) {
    logger.info({ pending: pendingRecordItems.length }, 'No public record anchors claimed; another worker may be processing them');
    return {
      processed: alreadyAnchored,
      anchorsCreated: createdAnchors.length,
      batchId: null,
      merkleRoot: null,
      txId: null,
      alreadyAnchored,
      claimed: 0,
    };
  }

  const uniqueClaimedAnchors = uniqueById(claimedAnchors);
  const fingerprints = uniqueClaimedAnchors.map((a) => a.fingerprint);
  const tree = buildMerkleTree(fingerprints);

  // Step 4: Submit one Merkle root to Bitcoin for the whole claimed batch.
  let receipt;
  try {
    const chainClient = await getChainClientAsync();
    receipt = await chainClient.submitFingerprint({
      fingerprint: tree.root,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({ error, merkleRoot: tree.root }, 'Public record batch chain submission failed');
    await revertClaimedAnchors(client, uniqueClaimedAnchors.map((a) => a.id));
    return {
      processed: alreadyAnchored,
      anchorsCreated: createdAnchors.length,
      batchId: null,
      merkleRoot: tree.root,
      txId: null,
      alreadyAnchored,
      claimed: uniqueClaimedAnchors.length,
    };
  }

  const batchId = `pr_batch_${Date.now()}_${uniqueClaimedAnchors.length}`;
  const txId = receipt.receiptId;

  logger.info(
    { batchId, merkleRoot: tree.root, txId, anchorCount: uniqueClaimedAnchors.length },
    'Merkle root anchored to chain',
  );

  // Step 5: Bulk-finalize anchors + records with per-record Merkle proofs.
  const finalizeItems = claimedRecordItems.map(({ record, anchor }) => ({
    record_id: record.id,
    anchor_id: anchor.id,
    merkle_proof: tree.proofs.get(anchor.fingerprint) ?? [],
  }));
  const { recordsUpdated: updateCount, anchorsUpdated } = await finalizePublicRecordAnchorBatch(
    client,
    finalizeItems,
    receipt,
    tree.root,
    batchId,
  );

  // Batch performance metrics
  const batchDurationMs = Date.now() - batchStartTime;
  const heapAfter = process.memoryUsage().heapUsed;
  const heapDeltaMB = (heapAfter - heapBefore) / 1024 / 1024;

  logger.info(
    {
      batchId,
      processed: updateCount,
      anchorsCreated: createdAnchors.length,
      anchorsUpdated,
      alreadyAnchored,
      claimed: uniqueClaimedAnchors.length,
      txId,
      batchMetrics: {
        batchSize: records.length,
        maxBatchSize: PUBLIC_RECORD_BATCH_SIZE,
        durationMs: batchDurationMs,
        recordsPerSecond: records.length > 0 ? (records.length / (batchDurationMs / 1000)).toFixed(1) : '0',
        heapDeltaMB: heapDeltaMB.toFixed(2),
        heapUsedMB: (heapAfter / 1024 / 1024).toFixed(1),
        merkleTreeDepth: Math.ceil(Math.log2(records.length || 1)),
      },
    },
    'Public record anchoring complete — individual anchors visible in Treasury',
  );

  return {
    processed: alreadyAnchored + updateCount,
    anchorsCreated: createdAnchors.length,
    batchId,
    merkleRoot: tree.root,
    txId,
    alreadyAnchored,
    claimed: uniqueClaimedAnchors.length,
  };
}
