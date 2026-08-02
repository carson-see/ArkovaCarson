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

import { db, withDbTimeout } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { getChainClientAsync } from '../chain/client.js';
import { buildMerkleTree } from '../utils/merkle.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { upsertAnchorProofs } from '../utils/anchorProofs.js';
import { resolveAnchorBatchSize } from './anchor-batching.js';
import {
  POSTGREST_ROW_LIMIT,
  assertNotAllChunksFailed,
  chunkForInFilter,
} from '../utils/postgrest-filter.js';
import type { ChainReceipt } from '../chain/types.js';

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

interface PipelineOwner {
  ownerId: string;
  ownerOrgId: string | null;
}

interface PipelineAnchorInsert {
  user_id: string;
  org_id: string | null;
  fingerprint: string;
  filename: string;
  credential_type: string;
  status: 'PENDING';
  description?: string;
  metadata: {
    pipeline_source: string;
    source_id: string;
    source_url: string | null;
    record_type: string;
  };
}

interface RecordAnchorPartition {
  alreadyAnchoredItems: RecordAnchorItem[];
  pendingRecordItems: Array<{ record: PipelinePublicRecord; anchor: PipelineAnchorRow }>;
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

/**
 * Every id filter in this module is built with `chunkForInFilter`, never a
 * hand-rolled `i += SIZE` loop; `POSTGREST_ROW_LIMIT` appears only on
 * `.range()` pagination, which is what it actually governs.
 */
async function fetchAnchorRows(
  client: SupabaseClient,
  anchorIds: string[],
): Promise<PipelineAnchorRow[]> {
  const rows: PipelineAnchorRow[] = [];
  const ids = Array.from(new Set(anchorIds));
  const chunks = chunkForInFilter(ids);
  let failedChunks = 0;

  for (const { values, start } of chunks) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (client as any)
      .from('anchors')
      .select('id, fingerprint, status, chain_tx_id, metadata')
      .in('id', values)
      .is('deleted_at', null);

    if (error) {
      failedChunks += 1;
      logger.error(
        { error, errorMessage: (error as { message?: string })?.message, chunkStart: start, chunkSize: values.length },
        'Failed to fetch anchor rows after insert',
      );
      continue;
    }

    rows.push(...((data ?? []) as PipelineAnchorRow[]));
  }

  // Every chunk failing is indistinguishable from "no anchors exist" downstream:
  // partitionRecordAnchors yields no pending items, the job logs a benign
  // "no new pending" and returns 200. That silent-success path is what hid a
  // 70-hour production outage.
  assertNotAllChunksFailed('fetchAnchorRows', chunks.length, failedChunks, `${ids.length} anchor id(s)`);

  return rows;
}

async function claimPendingPipelineAnchors(
  client: SupabaseClient,
  anchors: PipelineAnchorRow[],
): Promise<PipelineAnchorRow[]> {
  const claimed: PipelineAnchorRow[] = [];
  // Project to ids BEFORE chunking: `chunkForInFilter` only accepts the values
  // that go on the wire, so the width it guarantees is the width actually sent.
  const anchorIds = uniqueById(anchors).map((a) => a.id);
  const chunks = chunkForInFilter(anchorIds);
  let failedChunks = 0;

  for (const { values, start } of chunks) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (client as any)
      .from('anchors')
      .update({ status: 'BROADCASTING' })
      .in('id', values)
      .eq('status', 'PENDING')
      .select('id, fingerprint, status, chain_tx_id, metadata');

    if (error) {
      failedChunks += 1;
      logger.error({ error, chunkStart: start, chunkSize: values.length }, 'Failed to claim pipeline anchors');
      continue;
    }

    claimed.push(...((data ?? []) as PipelineAnchorRow[]));
  }

  // An empty claim reads downstream as "nothing was PENDING" — the job logs a
  // benign result and returns 200. That is the same silent-success shape as
  // fetchAnchorRows, and this function shipped without the guard while its two
  // siblings had it: the exact 2-of-3 miss that let #1795 leave a defect behind.
  assertNotAllChunksFailed(
    'claimPendingPipelineAnchors',
    chunks.length,
    failedChunks,
    `${anchorIds.length} anchor id(s)`,
  );

  return claimed;
}

interface RevertClaimedAnchorsResult {
  attemptedChunks: number;
  failedChunks: number;
  /** Anchors whose revert chunk failed — still BROADCASTING after this call. */
  strandedAnchorIds: number;
}

/**
 * Releases claimed pipeline anchors from BROADCASTING back to PENDING after a
 * failed chain submission.
 *
 * This ran with a `POSTGREST_ROW_LIMIT`-wide id filter until SCRUM-3031's
 * follow-up: PR #1795 corrected the same defect in `fetchAnchorRows` and
 * `claimPendingPipelineAnchors` but not here, so this path emitted 1,000-uuid
 * `in.(...)` filters, took 400 Bad Request on every chunk, and released
 * nothing. A failed submission therefore stranded up to a full 10,000-anchor
 * batch in BROADCASTING while the job logged only the original chain error.
 * The width is now `chunkForInFilter`'s to decide, not this function's.
 *
 * Silence on the revert is the dangerous part, not the stranding itself: the
 * `recover-broadcasts` cron eventually resets BROADCASTING rows with a NULL
 * `chain_tx_id` back to PENDING, so the batch does recover — but with no
 * signal, a permanently-broken revert is indistinguishable from a healthy one.
 * A total failure is therefore escalated to error level naming the stranded
 * count and the recovering job. It deliberately does NOT call
 * `assertNotAllChunksFailed` — this runs inside the chain-submission failure
 * path, and throwing here would replace the caller's real chain error with a
 * secondary one. That is an explicit opt-out, not an omission.
 */
async function revertClaimedAnchors(
  client: SupabaseClient,
  anchorIds: string[],
): Promise<RevertClaimedAnchorsResult> {
  let attemptedChunks = 0;
  let failedChunks = 0;
  let strandedAnchorIds = 0;

  for (const { values, start } of chunkForInFilter(anchorIds)) {
    attemptedChunks += 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (client as any)
      .from('anchors')
      .update({ status: 'PENDING' })
      .in('id', values)
      .eq('status', 'BROADCASTING');

    if (error) {
      failedChunks += 1;
      strandedAnchorIds += values.length;
      logger.error({ error, chunkStart: start, chunkSize: values.length }, 'Failed to revert claimed pipeline anchors');
    }
  }

  // The aggregate escalation is the CALLER's — it is the only one that knows
  // the merkle root and the claim size, and one failure should not produce
  // three stacked error lines saying the same thing.
  return { attemptedChunks, failedChunks, strandedAnchorIds };
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
  receipt: ChainReceipt,
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

async function publicRecordAnchoringEnabled(client: SupabaseClient): Promise<boolean> {
  const { data: enabled } = await client.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORD_ANCHORING',
  });
  if (!enabled) logger.info('ENABLE_PUBLIC_RECORD_ANCHORING is disabled — skipping');
  return Boolean(enabled);
}

async function fetchPipelineOwner(client: SupabaseClient): Promise<PipelineOwner | null> {
  const { data: adminProfile, error: adminError } = await client
    .from('profiles')
    .select('id, org_id')
    .eq('email', PIPELINE_OWNER_EMAIL)
    .single();

  if (adminError || !adminProfile) {
    logger.error({ error: adminError }, `Platform admin ${PIPELINE_OWNER_EMAIL} not found — cannot create anchors`);
    return null;
  }

  return {
    ownerId: adminProfile.id as string,
    ownerOrgId: (adminProfile.org_id as string) ?? null,
  };
}

const PRIORITY_SOURCES = ['courtlistener', 'edgar', 'federal_register', 'dapip'];
const PUBLIC_RECORD_SELECT = 'id, source, source_id, source_url, record_type, title, content_hash, metadata';

async function fetchRecordsForSource(
  client: SupabaseClient,
  source: string,
  limit: number,
): Promise<PipelinePublicRecord[]> {
  const records: PipelinePublicRecord[] = [];
  for (let offset = 0; offset < limit; offset += POSTGREST_ROW_LIMIT) {
    const chunkSize = Math.min(POSTGREST_ROW_LIMIT, limit - offset);
    const { data: chunk, error } = await client
      .from('public_records')
      .select(PUBLIC_RECORD_SELECT)
      .is('anchor_id', null)
      .eq('source', source)
      .order('created_at', { ascending: true })
      .range(offset, offset + chunkSize - 1);

    if (error) {
      logger.error({ error, offset, source }, 'Failed to fetch priority records chunk');
      break;
    }
    if (!chunk || chunk.length === 0) break;
    records.push(...(chunk as PipelinePublicRecord[]));
    if (chunk.length < chunkSize) break;
  }
  return records;
}

async function fetchNonPriorityRecords(
  client: SupabaseClient,
  limit: number,
): Promise<PipelinePublicRecord[]> {
  const records: PipelinePublicRecord[] = [];
  for (let offset = 0; offset < limit; offset += POSTGREST_ROW_LIMIT) {
    const chunkSize = Math.min(POSTGREST_ROW_LIMIT, limit - offset);
    const { data: chunk, error } = await client
      .from('public_records')
      .select(PUBLIC_RECORD_SELECT)
      .is('anchor_id', null)
      .not('source', 'in', `(${PRIORITY_SOURCES.join(',')})`)
      .order('created_at', { ascending: true })
      .range(offset, offset + chunkSize - 1);

    if (error) {
      logger.error({ error, offset }, 'Failed to fetch remaining records chunk');
      break;
    }
    if (!chunk || chunk.length === 0) break;
    records.push(...(chunk as PipelinePublicRecord[]));
    if (chunk.length < chunkSize) break;
  }
  return records;
}

async function fetchUnanchoredPublicRecords(client: SupabaseClient): Promise<PipelinePublicRecord[]> {
  // Fetch all priority sources in parallel (SCRUM-1296 N+1 fan-out cleanup).
  // Each source is independent, so we use Promise.all instead of sequential loop.
  // Cap per-source at a fair share of the batch size to avoid over-fetching.
  const perSourceCap = Math.ceil(PUBLIC_RECORD_BATCH_SIZE / PRIORITY_SOURCES.length);
  const sourceResults = await Promise.all(
    PRIORITY_SOURCES.map((source) => fetchRecordsForSource(client, source, perSourceCap)),
  );

  // Merge and cap total at PUBLIC_RECORD_BATCH_SIZE
  const records: PipelinePublicRecord[] = sourceResults.flat().slice(0, PUBLIC_RECORD_BATCH_SIZE);

  if (records.length < PUBLIC_RECORD_BATCH_SIZE) {
    records.push(...await fetchNonPriorityRecords(client, PUBLIC_RECORD_BATCH_SIZE - records.length));
  }
  return records;
}

function publicRecordDescription(record: PipelinePublicRecord): string | null {
  const meta = record.metadata ?? {};
  return (
    (typeof meta.abstract === 'string' ? meta.abstract : null)
    ?? (typeof meta.description === 'string' ? meta.description : null)
    ?? (typeof meta.summary === 'string' ? meta.summary : null)
  )?.slice(0, 500) ?? null;
}

function buildPipelineAnchorInsert(record: PipelinePublicRecord, owner: PipelineOwner): PipelineAnchorInsert {
  const description = publicRecordDescription(record);
  return {
    user_id: owner.ownerId,
    org_id: owner.ownerOrgId,
    fingerprint: record.content_hash,
    filename: buildAnchorFilename(record),
    credential_type: mapCredentialType(record.source),
    status: 'PENDING',
    ...(description ? { description } : {}),
    metadata: {
      pipeline_source: record.source,
      source_id: record.source_id,
      source_url: record.source_url,
      record_type: record.record_type,
    },
  };
}

async function findExistingAnchor(
  client: SupabaseClient,
  ownerId: string,
  fingerprint: string,
): Promise<{ id: string; fingerprint: string } | null> {
  const { data: existing, error } = await client
    .from('anchors')
    .select('id, fingerprint')
    .eq('user_id', ownerId)
    .eq('fingerprint', fingerprint)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.error({ error, ownerId, fingerprint }, 'findExistingAnchor query failed');
    return null;
  }
  return (existing as { id: string; fingerprint: string } | null) ?? null;
}

async function insertAnchorSerialFallback(
  client: SupabaseClient,
  chunk: PipelineAnchorInsert[],
  ownerId: string,
): Promise<Array<{ id: string; fingerprint: string }>> {
  const created: Array<{ id: string; fingerprint: string }> = [];
  for (const anchor of chunk) {
    const { data: inserted, error: insertError } = await client
      .from('anchors')
      .insert(anchor)
      .select('id, fingerprint')
      .single();

    if (insertError?.code === '23505') {
      const existing = await findExistingAnchor(client, ownerId, anchor.fingerprint);
      if (existing) created.push(existing);
      continue;
    }
    if (insertError) {
      logger.error({ error: insertError, fingerprint: anchor.fingerprint }, 'Failed to create anchor');
      continue;
    }
    if (inserted) created.push(inserted as { id: string; fingerprint: string });
  }
  return created;
}

// SCRUM-3031: hard client-side ceiling on the batch_insert_anchors RPC call.
// Well below the RPC's own 120s statement_timeout (see migration 0370) so
// the worker fails fast and falls back to serial inserts instead of
// blocking indefinitely on a wedged call — the root-cause fix (0370) makes
// this call cheap even at prod scale, but this is defense-in-depth against
// any future regression re-wedging the same table.
export const BATCH_INSERT_RPC_TIMEOUT_MS = 20_000;

function isRpcTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('timed out');
}

/** Narrow shape of what `client.rpc(...)` returns that this function relies
 *  on: a thenable resolving to `{ data, error }`, optionally chainable with
 *  `.abortSignal()` (real supabase-js `PostgrestFilterBuilder` always has
 *  this; kept optional here only so lightweight test doubles that return a
 *  bare Promise don't need to implement the full builder surface). */
type AbortableRpcResult = PromiseLike<{ data: unknown; error: unknown }> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<{ data: unknown; error: unknown }>;
};

/**
 * Calls batch_insert_anchors with a hard client-side timeout — SINGLE
 * ATTEMPT, no retry (SCRUM-3031 review follow-up).
 *
 * A prior version of this function retried timeout-classified failures up
 * to 3x with jittered backoff. That was a correctness bug, not a hardening
 * improvement: `withDbTimeout` is a bare `Promise.race` against a
 * `setTimeout` — when it "times out" client-side, the original RPC call
 * (and, critically, the Postgres backend query it triggered) does NOT stop.
 * PostgREST does not cancel the backend statement when the HTTP client
 * disconnects (open PostgREST behavior — see
 * https://github.com/PostgREST/postgrest/issues/3517 — "the underlying
 * query continues to run on PostgREST['s] db pool [...] until reaching its
 * timeout"). So a "timeout then retry" here used to launch a SECOND
 * `batch_insert_anchors` execution while the FIRST one could still be
 * running server-side, holding `RowExclusiveLock` on `anchors` — up to 3
 * stacked overlapping executions on repeated timeouts. That is the exact
 * wedge scenario this hardening exists to prevent, so the retry loop could
 * make it worse, not better.
 *
 * Fix: this function now makes exactly ONE attempt. It still passes an
 * `AbortController` signal into `client.rpc(...).abortSignal(...)` so a
 * timed-out attempt aborts the CLIENT-SIDE fetch — this frees the local
 * HTTP connection/socket immediately instead of leaking it until the RPC's
 * own 120s `statement_timeout` elapses, and gives the fastest possible
 * local signal that the call is dead. But per the PostgREST issue above,
 * this abort is NOT guaranteed to cancel the server-side Postgres
 * statement — do not rely on it for that. On a timeout, we do not retry;
 * we surface the error immediately, exactly like a real (non-timeout)
 * Postgrest error, and the caller (`insertAnchorChunk`) falls through to
 * `insertAnchorSerialFallback`. That per-row fallback can theoretically
 * still contend with a still-running original statement's row locks, but
 * that is bounded, row-level contention — nothing like the "up to 3
 * stacked full-batch executions holding a table-wide lock" scenario the
 * retry loop introduced.
 *
 * Exported for direct unit testing (mirrors buildAnchorFilename /
 * mapCredentialType already being exported for the same reason).
 */
export async function callBatchInsertAnchorsOnce(
  client: SupabaseClient,
  chunk: PipelineAnchorInsert[],
  chunkStart: number,
): Promise<{ data: Array<{ id: string; fingerprint: string }> | null; error: unknown }> {
  const controller = new AbortController();
  // Abort the client-side fetch at the same deadline withDbTimeout uses, so
  // a timed-out attempt's connection is torn down promptly rather than left
  // to run until the RPC's own 120s statement_timeout (see function
  // docstring — this does NOT guarantee server-side statement cancellation).
  const abortTimer = setTimeout(() => controller.abort(), BATCH_INSERT_RPC_TIMEOUT_MS);

  try {
    const { data, error } = await withDbTimeout(
      // Wrapped in an async arrow so this is a real Promise<T> — the
      // PostgrestFilterBuilder client.rpc() returns is PromiseLike but
      // doesn't structurally match Promise<T> for withDbTimeout's generic.
      async () => {
        const builder = client.rpc('batch_insert_anchors', { p_anchors: chunk }) as unknown as AbortableRpcResult;
        const withAbort = typeof builder.abortSignal === 'function'
          ? builder.abortSignal(controller.signal)
          : builder;
        return withAbort;
      },
      BATCH_INSERT_RPC_TIMEOUT_MS,
    );
    // A returned (not thrown) Postgrest error is a real failure, not a
    // timeout — surface it immediately, same as pre-SCRUM-3031 behavior.
    return { data: (data ?? null) as Array<{ id: string; fingerprint: string }> | null, error: error ?? null };
  } catch (err) {
    if (isRpcTimeoutError(err)) {
      logger.warn(
        { chunkIndex: chunkStart, chunkSize: chunk.length },
        'batch_insert_anchors RPC timed out — client-side fetch aborted; NOT retrying (a second concurrent execution against the same rows is exactly the wedge this hardening prevents); falling back to serial insert',
      );
    }
    return { data: null, error: err };
  } finally {
    clearTimeout(abortTimer);
  }
}

async function insertAnchorChunk(
  client: SupabaseClient,
  chunk: PipelineAnchorInsert[],
  chunkStart: number,
  ownerId: string,
): Promise<Array<{ id: string; fingerprint: string }>> {
  const { data: result, error: rpcError } = await callBatchInsertAnchorsOnce(client, chunk, chunkStart);

  if (rpcError) {
    logger.error({ error: rpcError, chunkIndex: chunkStart, chunkSize: chunk.length }, 'Batch insert RPC failed — falling back to serial inserts');
    return insertAnchorSerialFallback(client, chunk, ownerId);
  }

  const anchors = (result ?? []) as Array<{ id: string; fingerprint: string }>;
  logger.info({ chunk: Math.floor(chunkStart / ANCHOR_INSERT_CHUNK) + 1, inserted: anchors.length }, 'Batch insert chunk complete');
  return anchors;
}

async function createPublicRecordAnchors(
  client: SupabaseClient,
  anchorInserts: PipelineAnchorInsert[],
  ownerId: string,
): Promise<Array<{ id: string; fingerprint: string }>> {
  const createdAnchors: Array<{ id: string; fingerprint: string }> = [];
  for (let i = 0; i < anchorInserts.length; i += ANCHOR_INSERT_CHUNK) {
    const chunk = anchorInserts.slice(i, i + ANCHOR_INSERT_CHUNK);
    createdAnchors.push(...await insertAnchorChunk(client, chunk, i, ownerId));
  }
  return createdAnchors;
}

function partitionRecordAnchors(
  records: PipelinePublicRecord[],
  anchorRows: PipelineAnchorRow[],
): RecordAnchorPartition {
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
  return { alreadyAnchoredItems, pendingRecordItems };
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

  if (!(await publicRecordAnchoringEnabled(client))) {
    return { processed: 0, anchorsCreated: 0, batchId: null, merkleRoot: null, txId: null };
  }

  const owner = await fetchPipelineOwner(client);
  if (!owner) {
    return { processed: 0, anchorsCreated: 0, batchId: null, merkleRoot: null, txId: null };
  }

  const records = await fetchUnanchoredPublicRecords(client);

  if (!records || records.length < MIN_BATCH_SIZE) {
    logger.info({ count: records?.length ?? 0 }, 'No unanchored records to process');
    return { processed: 0, anchorsCreated: 0, batchId: null, merkleRoot: null, txId: null };
  }

  const batchStartTime = Date.now();
  const heapBefore = process.memoryUsage().heapUsed;
  logger.info({ recordCount: records.length, batchSize: PUBLIC_RECORD_BATCH_SIZE }, 'Creating individual anchors for public records');

  // Step 1: Create individual anchor records for each public record
  const anchorInserts = records.map((record) => buildPipelineAnchorInsert(record, owner));
  const createdAnchors = await createPublicRecordAnchors(client, anchorInserts, owner.ownerId);

  logger.info({ created: createdAnchors.length, total: records.length }, 'Anchor records created (batch RPC)');

  if (createdAnchors.length === 0) {
    logger.warn('No new anchors created (all may be duplicates)');
    return { processed: 0, anchorsCreated: 0, batchId: null, merkleRoot: null, txId: null };
  }

  // Step 2: Resolve anchor status. Already-submitted duplicate records can be
  // linked without burning another Bitcoin transaction.
  const anchorRows = await fetchAnchorRows(client, createdAnchors.map((a) => a.id));
  const { alreadyAnchoredItems, pendingRecordItems } = partitionRecordAnchors(records, anchorRows);

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
    const revert = await revertClaimedAnchors(client, uniqueClaimedAnchors.map((a) => a.id));
    if (revert.strandedAnchorIds > 0) {
      logger.error(
        { merkleRoot: tree.root, claimed: uniqueClaimedAnchors.length, ...revert },
        'Public record batch failed AND its claim could not be fully released — anchors left BROADCASTING; recover-broadcasts will reset those with a NULL chain_tx_id',
      );
    }
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
