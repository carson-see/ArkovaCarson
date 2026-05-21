/**
 * Check Confirmations Job (BETA-01)
 *
 * Polls mempool.space REST API for SUBMITTED anchors to check if their
 * Bitcoin transactions have been confirmed. Promotes SUBMITTED → SECURED
 * when a transaction is mined into a block.
 *
 * Constitution refs:
 *   - 1.4: No PII in mempool API calls, no secrets logged
 *   - 1.9: Gated by ENABLE_PROD_NETWORK_ANCHORING switchboard flag
 *
 * Stories: BETA-01
 */

import type { AuditEventCategory } from '../types/audit-event-category.js';
import { db } from '../utils/db.js';
import { invalidateVerificationCache } from '../utils/verifyCache.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { dispatchWebhookEvent } from '../webhooks/delivery.js';
import { runWithConcurrency } from '../utils/concurrency.js';

/** Maximum unique transactions to check per cron run (rate limit mempool.space) */
const MAX_TX_CHECKS_PER_RUN = 100;

/** Rows fetched per submitted-anchor candidate page. */
const SUBMITTED_TX_CANDIDATE_PAGE_SIZE = 500;

/** Maximum submitted-anchor rows to scan while building a tx candidate set. */
const MAX_SUBMITTED_TX_CANDIDATE_ROWS_PER_RUN = 5_000;

/** Concurrency for parallel mempool.space API calls */
const MEMPOOL_CONCURRENCY = 10;

/**
 * Concurrency cap for the SCRUM-1264 (R2-1) bulk-confirm webhook fan-out.
 * Conservative default — a 10K-anchor merkle batch sends 10K dispatches but
 * never more than this many in flight at once, so a customer with one slow
 * endpoint can't be DDoS'd by our own fan-out. Override via env if needed.
 */
const BULK_WEBHOOK_FAN_OUT_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.BULK_WEBHOOK_FAN_OUT_CONCURRENCY ?? '20', 10) || 20,
);

type SecuredWebhookAnchor = {
  public_id: string | null;
  org_id: string | null;
};

type BatchSecuredAuditRow = {
  event_type: string;
  event_category: AuditEventCategory;
  // null = system-driven event (cron / queue worker), not user-attributable.
  // Pre-PR-#753 used a zero-UUID literal which violated audit_events_actor_id_fkey.
  actor_id: string | null;
  target_type: string;
  target_id: string;
  org_id: string | null;
  details: string;
};

type SubmittedTxCandidateRow = {
  id?: string | null;
  chain_tx_id: string | null;
  created_at?: string | null;
};

type SubmittedTxScanCursor = {
  createdAt: string;
  id: string;
};

type SubmittedTxCandidateFetchResult = {
  rows: SubmittedTxCandidateRow[];
  scannedRows: number;
  uniqueTxIds: number;
  wrapped: boolean;
  cursorCreatedAt: string | null;
  cursorId: string | null;
  error: unknown | null;
};

interface SubmittedTxCandidateScanState {
  rows: SubmittedTxCandidateRow[];
  uniqueTxIds: Set<string>;
  scannedRows: number;
  wrapped: boolean;
  cursor: SubmittedTxScanCursor | null;
  canContinue: boolean;
}

let submittedTxScanCursor: SubmittedTxScanCursor | null = null;

export function resetSubmittedTxScanCursorForTests(): void {
  submittedTxScanCursor = null;
}

function normalizeDrainedAnchors(value: unknown): SecuredWebhookAnchor[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      return {
        public_id: typeof row.public_id === 'string' ? row.public_id : null,
        org_id: typeof row.org_id === 'string' ? row.org_id : null,
      };
    })
    .filter((item): item is SecuredWebhookAnchor => item !== null);
}

function invalidateDrainedVerificationCaches(anchors: SecuredWebhookAnchor[]): void {
  const publicIds = new Set(
    anchors.map((anchor) => anchor.public_id).filter((publicId): publicId is string => Boolean(publicId)),
  );

  for (const publicId of publicIds) {
    void invalidateVerificationCache(publicId);
  }
}

function summarizeDrainedOrgCounts(anchors: SecuredWebhookAnchor[]): Array<{ orgId: string | null; count: number }> {
  const counts = new Map<string | null, number>();
  for (const anchor of anchors) {
    counts.set(anchor.org_id, (counts.get(anchor.org_id) ?? 0) + 1);
  }
  return Array.from(counts, ([orgId, count]) => ({ orgId, count }));
}

function buildBatchSecuredAuditRows(
  txId: string,
  groupConfirmed: number,
  blockHeight: number,
  confirmations: number,
  drainedAnchors: SecuredWebhookAnchor[],
): BatchSecuredAuditRow[] {
  const orgCounts = summarizeDrainedOrgCounts(drainedAnchors);
  const attributedCount = orgCounts.reduce((sum, row) => sum + row.count, 0);
  const unknownCount = Math.max(groupConfirmed - attributedCount, 0);
  const rows: BatchSecuredAuditRow[] = orgCounts.map(({ orgId, count }) => ({
    event_type: 'anchor.batch_secured',
    event_category: 'ANCHOR' as const,
    // System-driven event; audit_events.actor_id is nullable for system rows
    // (see e.g. user.data_anonymized in the prod migrations). The pre-PR-#753
    // hardcoded zero-UUID violated the audit_events_actor_id_fkey constraint
    // in every environment that didn't seed a zero-UUID profile — silently
    // failing every batch audit insert.
    actor_id: null,
    target_type: 'anchor',
    target_id: txId,
    org_id: orgId,
    details: `Batch confirmed ${count} anchors at block ${blockHeight} (tx: ${txId}, ${confirmations} confirmations; tx_total: ${groupConfirmed})`,
  }));

  if (rows.length === 0 || unknownCount > 0) {
    rows.push({
      event_type: 'anchor.batch_secured',
      event_category: 'ANCHOR',
      // System-driven event; audit_events.actor_id is nullable for system rows
    // (see e.g. user.data_anonymized in the prod migrations). The pre-PR-#753
    // hardcoded zero-UUID violated the audit_events_actor_id_fkey constraint
    // in every environment that didn't seed a zero-UUID profile — silently
    // failing every batch audit insert.
    actor_id: null,
      target_type: 'anchor',
      target_id: txId,
      org_id: null,
      details: `Batch confirmed ${unknownCount || groupConfirmed} anchors at block ${blockHeight} (tx: ${txId}, ${confirmations} confirmations; org attribution unavailable)`,
    });
  }

  return rows;
}

export async function fanOutSecuredAnchorWebhooks(
  anchors: SecuredWebhookAnchor[],
  txId: string,
  blockHeight: number,
  blockTimestamp: string,
): Promise<void> {
  const eligible = anchors.filter(
    (a): a is { public_id: string; org_id: string } =>
      typeof a.org_id === 'string' && typeof a.public_id === 'string' && a.public_id.length > 0,
  );

  if (eligible.length === 0) {
    logger.debug(
      { txId, anchorsTotal: anchors.length },
      'Bulk webhook fan-out: no anchors with both org_id + public_id; nothing to dispatch',
    );
    return;
  }

  // SCRUM-1800 (SCRUM-1743 Phase 2c): fetch credential_type for the drained
  // anchors so we can also dispatch credential.status_changed alongside
  // anchor.secured. The drain RPC (drain_submitted_to_secured_for_tx) only
  // returns public_id + org_id; credential_type comes from chunked bulk
  // SELECTs here. credential.status_changed schema requires credential_type;
  // anchors missing it skip the credential.* dispatch (anchor.* still fires).
  //
  // CodeRabbit PR #753: chunk the `.in()` lookup to 500 entries. Supabase-js
  // serializes `.in()` as a URL query param; 10K-anchor merkle batches
  // exceed PostgREST's URI length and trigger HTTP 414, dropping all
  // credential.* events for that batch. Same chunk size as PROOF_UPSERT_CHUNK
  // in anchorProofs.ts. Per-chunk failures are logged but other chunks still
  // populate the map, so a partial outage doesn't silently drop the whole
  // batch's credential events.
  const CRED_LOOKUP_CHUNK = 500;
  const credentialTypeByPublicId = new Map<string, string>();
  const publicIdsForLookup = eligible.map((a) => a.public_id);
  for (let i = 0; i < publicIdsForLookup.length; i += CRED_LOOKUP_CHUNK) {
    const chunk = publicIdsForLookup.slice(i, i + CRED_LOOKUP_CHUNK);
    try {
      // PR #753 audit fix C1: org-blind query is intentional and safe here.
      // The `eligible` array (built upstream from the drain RPC's per-tx
      // anchor list) carries each anchor's `org_id`, and every downstream
      // dispatch uses `dispatchWebhookEvent(anchor.org_id, …)` which scopes
      // the webhook_endpoints SELECT by org_id. The credential_type lookup
      // is read-only metadata enrichment; cross-org leakage at this step
      // would require a downstream caller to bypass the per-anchor org_id
      // routing, which doesn't happen in the fan-out task closures below.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- batch fan-out: scoped by upstream drain set, org routing enforced in dispatch closures
      const { data: credRows, error: credErr } = await (db as any)
        .from('anchors')
        .select('public_id, credential_type')
        .in('public_id', chunk);
      if (credErr) {
        logger.warn(
          { txId, error: credErr, chunkStart: i, chunkSize: chunk.length },
          'Failed to fetch credential_type chunk for credential.status_changed fan-out — chunk skipped, others continue',
        );
        continue;
      }
      if (Array.isArray(credRows)) {
        for (const row of credRows) {
          if (row && typeof row.public_id === 'string' && typeof row.credential_type === 'string') {
            credentialTypeByPublicId.set(row.public_id, row.credential_type);
          }
        }
      }
    } catch (lookupError) {
      logger.warn(
        { txId, error: lookupError, chunkStart: i, chunkSize: chunk.length },
        'credential_type chunked lookup threw — chunk skipped, others continue',
      );
    }
  }

  // SCRUM-1800 (SCRUM-1743 Phase 2c): track per-org credential.status_changed
  // dispatch outcomes so the per-batch audit row records dispatched/failed
  // counts plus a sample of failure reasons. Avoids the previous "first error
  // only" reporting which lost 99 out of 100 failure causes on bad batches.
  const credentialOutcomes = new Map<string, {
    dispatched: number;
    failed: number;
    sample_failures: Array<{ public_id: string; error: string }>;
  }>();
  const recordCredentialOutcome = (orgId: string, publicId: string, error: unknown | null) => {
    const slot = credentialOutcomes.get(orgId) ?? { dispatched: 0, failed: 0, sample_failures: [] };
    if (error) {
      slot.failed++;
      if (slot.sample_failures.length < 5) {
        const msg = error instanceof Error ? error.message : String(error);
        slot.sample_failures.push({ public_id: publicId, error: msg });
      }
    } else {
      slot.dispatched++;
    }
    credentialOutcomes.set(orgId, slot);
  };

  const tasks = eligible.flatMap((anchor) => {
    const baseTask = async () => {
      await dispatchWebhookEvent(anchor.org_id, 'anchor.secured', anchor.public_id, {
        public_id: anchor.public_id,
        status: 'SECURED',
        chain_tx_id: txId,
        chain_block_height: blockHeight,
        chain_timestamp: blockTimestamp,
        secured_at: blockTimestamp,
      });
    };
    const credentialType = credentialTypeByPublicId.get(anchor.public_id);
    if (!credentialType) return [baseTask];
    // SCRUM-1800: credential.status_changed alongside anchor.secured.
    // previous_status: 'SUBMITTED' is the most accurate label for the
    // bulk-confirm path (PENDING anchors flow through SUBMITTED before
    // SECURED via the merkle-batch broadcast in jobs/batch-anchor.ts).
    const credentialTask = async () => {
      try {
        await dispatchWebhookEvent(anchor.org_id, 'credential.status_changed', anchor.public_id, {
          public_id: anchor.public_id,
          credential_type: credentialType,
          previous_status: 'SUBMITTED',
          new_status: 'SECURED',
          changed_at: blockTimestamp,
        });
        recordCredentialOutcome(anchor.org_id, anchor.public_id, null);
      } catch (emitErr) {
        recordCredentialOutcome(anchor.org_id, anchor.public_id, emitErr);
        // Re-throw so runWithConcurrency.rejected still surfaces the failure
        // for the existing logger.warn aggregate at line ~280.
        throw emitErr;
      }
    };
    return [baseTask, credentialTask];
  });

  // SCRUM-1800: tally planned credential.status_changed dispatches per org.
  // Used to write a single per-org audit row at the end of the batch (vs.
  // per-anchor — which would multiply audit volume by ~10K on a typical merkle
  // batch). Counts the number of credential events we *attempted* to dispatch;
  // the webhook_delivery_logs table records per-attempt outcome.
  const credentialOrgCounts = new Map<string, number>();
  const credentialPublicIdsByOrg = new Map<string, string[]>();
  for (const anchor of eligible) {
    if (credentialTypeByPublicId.has(anchor.public_id)) {
      credentialOrgCounts.set(anchor.org_id, (credentialOrgCounts.get(anchor.org_id) ?? 0) + 1);
      const existing = credentialPublicIdsByOrg.get(anchor.org_id) ?? [];
      // Cap stored IDs per org to keep audit row size bounded — a 10K-credential
      // merkle batch should not produce a 1MB JSON details column.
      if (existing.length < 100) existing.push(anchor.public_id);
      credentialPublicIdsByOrg.set(anchor.org_id, existing);
    }
  }

  const result = await runWithConcurrency(tasks, BULK_WEBHOOK_FAN_OUT_CONCURRENCY);

  // SCRUM-1800: write per-org credential.status_changed.batch audit row(s)
  // after the fan-out completes. One row per org with at least one credential
  // event in this batch — keeps audit volume bounded while preserving the
  // tamper-evident link to the underlying merkle tx.
  if (credentialOrgCounts.size > 0) {
    const credAuditRows = Array.from(credentialOrgCounts.entries()).map(([orgId, count]) => {
      const outcome = credentialOutcomes.get(orgId) ?? {
        dispatched: 0,
        failed: 0,
        sample_failures: [],
      };
      return {
        event_type: 'credential.status_changed.batch',
        event_category: 'WEBHOOK' as const,
        // System-driven event; audit_events.actor_id is nullable for system rows
    // (see e.g. user.data_anonymized in the prod migrations). The pre-PR-#753
    // hardcoded zero-UUID violated the audit_events_actor_id_fkey constraint
    // in every environment that didn't seed a zero-UUID profile — silently
    // failing every batch audit insert.
    actor_id: null,
        target_type: 'anchor',
        target_id: txId,
        org_id: orgId,
        details: JSON.stringify({
          chain_tx_id: txId,
          block_height: blockHeight,
          previous_status: 'SUBMITTED',
          new_status: 'SECURED',
          credentials_dispatched_attempted: count,
          // SCRUM-1800: per-emit outcome counters + first 5 failure samples.
          // Lets operators answer "did anything in this batch fail?" without
          // joining webhook_delivery_logs, and recover dropped events via
          // SCRUM-1738 retry path using the captured public_ids.
          credentials_dispatched_succeeded: outcome.dispatched,
          credentials_dispatched_failed: outcome.failed,
          sample_failures: outcome.sample_failures,
          sample_public_ids: credentialPublicIdsByOrg.get(orgId) ?? [],
        }),
      };
    });
    try {
      const { error: credAuditErr } =
        credAuditRows.length === 1
          ? await db.from('audit_events').insert(credAuditRows[0])
          : await db.from('audit_events').insert(credAuditRows);
      if (credAuditErr) {
        logger.warn(
          { txId, error: credAuditErr },
          'Failed to insert credential.status_changed.batch audit rows',
        );
      }
    } catch (auditError) {
      logger.warn(
        { txId, error: auditError },
        'credential.status_changed.batch audit insert threw',
      );
    }
  }

  if (result.rejected.length > 0) {
    const firstReason = result.rejected[0]?.reason;
    const formatReason = (reason: unknown): string => {
      if (reason instanceof Error) return reason.message;
      if (reason === null || reason === undefined) return 'unknown';
      try {
        return JSON.stringify(reason);
      } catch {
        return String(reason);
      }
    };
    logger.warn(
      {
        txId,
        anchorsDispatched: result.fulfilled.length,
        anchorsFailed: result.rejected.length,
        firstError: formatReason(firstReason),
      },
      'Bulk webhook fan-out: some dispatches failed (DLQ holds the durable retries)',
    );
  } else {
    logger.info(
      { txId, anchorsDispatched: result.fulfilled.length },
      'Bulk webhook fan-out: anchor.secured delivered for all anchors in tx',
    );
  }
}

/**
 * Fan out per-anchor `anchor.secured` webhooks after the bulk SECURED update.
 * SCRUM-1264 (R2-1) — restores the customer-facing webhook contract that
 * commit a5da008d (2026-03-27) silently dropped. Per-org grouping keeps the
 * fan-out symmetric to the single-anchor path: one event per anchor per
 * subscribed endpoint, capped at BULK_WEBHOOK_FAN_OUT_CONCURRENCY in flight.
 *
 * Failures land in `webhook_dead_letter_queue` via the existing dispatch
 * machinery — this function never throws. Errors are logged with txId
 * + counts so operators can correlate against the merkle batch.
 */
export async function fanOutBulkSecuredWebhooks(
  txId: string,
  blockHeight: number,
  blockTimestamp: string,
): Promise<void> {
  // SCRUM-1268 (R2-5): only public-allowed columns are pulled from the DB —
  // anchor.id (UUID) and anchor.fingerprint stay server-side, never enter
  // the webhook payload.
  //
  // PR #567 Codex P1 fix: a transient queryErr here would silently drop the
  // entire merkle-batch's customer webhooks (anchors are already SECURED,
  // future cron runs only scan SUBMITTED — no retry path). Inline retry
  // with backoff (3 attempts) before giving up, then log loud + emit Sentry
  // breadcrumb so operators can recover via a one-off script.
  let securedAnchors: Array<{ id: string; public_id: string | null; org_id: string | null }> | null = null;
  let queryErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await db
      .from('anchors')
      .select('id, public_id, org_id')
      .eq('chain_tx_id', txId)
      .eq('status', 'SECURED');
    if (!result.error) {
      securedAnchors = result.data ?? [];
      queryErr = null;
      break;
    }
    queryErr = result.error;
    if (attempt < 2) {
      const backoffMs = 250 * Math.pow(2, attempt); // 250ms, 500ms
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  if (queryErr) {
    logger.error(
      { txId, error: queryErr, anchorsConfirmed: 'unknown — query failed' },
      'Bulk webhook fan-out: SECURED anchors query failed after 3 retries — customer webhooks for this tx will NOT be dispatched. Operators must replay via a one-off script. (PR #567 Codex P1)',
    );
    return;
  }

  if (!securedAnchors || securedAnchors.length === 0) {
    return;
  }

  await fanOutSecuredAnchorWebhooks(securedAnchors, txId, blockHeight, blockTimestamp);
}

/** In-process mutex — prevents concurrent confirmation check runs */
let confirmationCheckRunning = false;

/** Minimum confirmations to consider a transaction confirmed.
 * CRIT-1: 6 confirmations for mainnet (Bitcoin Core standard for "settled"),
 * 1 for signet/testnet (fast development cycles).
 * On mainnet, 1-block reorgs occur ~monthly. 6 confirmations makes reorg
 * invalidation statistically negligible (probability < 1e-10).
 */
function getMinConfirmations(): number {
  return config.bitcoinNetwork === 'mainnet' ? 6 : 1;
}

async function fetchSubmittedTxCandidatePage(
  afterCursor: SubmittedTxScanCursor | null,
  limit: number,
): Promise<{ data: SubmittedTxCandidateRow[] | null; error: unknown | null }> {
  let query = db
    .from('anchors')
    .select('id, chain_tx_id, created_at')
    .eq('status', 'SUBMITTED')
    .not('chain_tx_id', 'is', null)
    .is('deleted_at', null);

  if (afterCursor) {
    query = query.or(
      `created_at.gt.${afterCursor.createdAt},and(created_at.eq.${afterCursor.createdAt},id.gt.${afterCursor.id})`,
    );
  }

  const { data, error } = await query
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit);
  return { data: (data ?? null) as SubmittedTxCandidateRow[] | null, error };
}

function hasSubmittedTxCandidateCapacity(state: SubmittedTxCandidateScanState): boolean {
  return (
    state.scannedRows < MAX_SUBMITTED_TX_CANDIDATE_ROWS_PER_RUN
    && state.uniqueTxIds.size < MAX_TX_CHECKS_PER_RUN
  );
}

function buildSubmittedTxCandidateResult(
  state: SubmittedTxCandidateScanState,
  error: unknown | null,
): SubmittedTxCandidateFetchResult {
  return {
    rows: state.rows,
    scannedRows: state.scannedRows,
    uniqueTxIds: state.uniqueTxIds.size,
    wrapped: state.wrapped,
    cursorCreatedAt: state.cursor?.createdAt ?? null,
    cursorId: state.cursor?.id ?? null,
    error,
  };
}

function processSubmittedTxCandidateRow(
  state: SubmittedTxCandidateScanState,
  row: SubmittedTxCandidateRow,
): void {
  state.rows.push(row);
  state.scannedRows++;
  if (row.chain_tx_id) state.uniqueTxIds.add(row.chain_tx_id);

  const rowCreatedAt = row.created_at ?? null;
  const rowId = row.id ?? null;
  if (!rowCreatedAt || !rowId) {
    logger.warn(
      { scannedRows: state.scannedRows, uniqueTxIds: state.uniqueTxIds.size },
      'Confirmation candidate scan could not advance cursor because submitted rows lacked id or created_at',
    );
    state.canContinue = false;
    return;
  }

  state.cursor = { createdAt: rowCreatedAt, id: rowId };
  state.canContinue = hasSubmittedTxCandidateCapacity(state);
}

function maybeWrapSubmittedTxCandidateScan(
  state: SubmittedTxCandidateScanState,
  pageStartedAfterCursor: boolean,
): boolean {
  if (pageStartedAfterCursor && !state.wrapped) {
    state.cursor = null;
    state.wrapped = true;
    return true;
  }

  state.canContinue = false;
  return false;
}

async function fetchSubmittedTxCandidates(): Promise<SubmittedTxCandidateFetchResult> {
  const state: SubmittedTxCandidateScanState = {
    rows: [],
    uniqueTxIds: new Set<string>(),
    scannedRows: 0,
    wrapped: false,
    cursor: submittedTxScanCursor,
    canContinue: true,
  };

  while (state.canContinue && hasSubmittedTxCandidateCapacity(state)) {
    const remaining = MAX_SUBMITTED_TX_CANDIDATE_ROWS_PER_RUN - state.scannedRows;
    const limit = Math.min(SUBMITTED_TX_CANDIDATE_PAGE_SIZE, remaining);
    const pageStartedAfterCursor = Boolean(state.cursor);
    const { data, error } = await fetchSubmittedTxCandidatePage(state.cursor, limit);

    if (error) {
      return buildSubmittedTxCandidateResult(state, error);
    }

    if (!data || data.length === 0) {
      if (maybeWrapSubmittedTxCandidateScan(state, pageStartedAfterCursor)) continue;
      break;
    }

    for (const row of data) {
      processSubmittedTxCandidateRow(state, row);
      if (!state.canContinue) break;
    }

    if (state.canContinue && data.length < limit) {
      if (maybeWrapSubmittedTxCandidateScan(state, pageStartedAfterCursor)) continue;
      break;
    }
  }

  submittedTxScanCursor = state.cursor;
  return buildSubmittedTxCandidateResult(state, null);
}

/**
 * Mempool.space transaction status response shape
 */
interface MempoolTxStatus {
  confirmed: boolean;
  block_height?: number;
  block_time?: number;
  block_hash?: string;
}

interface MempoolTxResponse {
  txid: string;
  status: MempoolTxStatus;
}

/**
 * Get the mempool.space API base URL for the configured network.
 */
function getMempoolBaseUrl(): string {
  if (config.mempoolApiUrl) {
    return config.mempoolApiUrl;
  }

  const networkPaths: Record<string, string> = {
    testnet4: 'https://mempool.space/testnet4',
    testnet: 'https://mempool.space/testnet',
    signet: 'https://mempool.space/signet',
    mainnet: 'https://mempool.space',
  };

  return networkPaths[config.bitcoinNetwork] ?? 'https://mempool.space/signet';
}

/**
 * Fetch transaction status from mempool.space REST API.
 *
 * @param txid - The transaction ID to look up
 * @returns Transaction response or null if not found/error
 */
/** ERR-2: Retry with exponential backoff for transient mempool.space failures */
const MEMPOOL_MAX_RETRIES = 3;
const MEMPOOL_INITIAL_BACKOFF_MS = 500;

/** Blockstream.info fallback base URLs */
function getBlockstreamBaseUrl(): string {
  const networkPaths: Record<string, string> = {
    testnet4: 'https://blockstream.info/testnet',
    testnet: 'https://blockstream.info/testnet',
    signet: 'https://blockstream.info/signet',
    mainnet: 'https://blockstream.info',
  };
  return networkPaths[config.bitcoinNetwork] ?? 'https://blockstream.info/signet';
}

async function fetchTxStatus(txid: string): Promise<MempoolTxResponse | null> {
  const baseUrl = getMempoolBaseUrl();
  const url = `${baseUrl}/api/tx/${txid}`;

  // ERR-2: Retry with exponential backoff
  for (let attempt = 0; attempt <= MEMPOOL_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        return (await response.json()) as MempoolTxResponse;
      }

      if (response.status === 404) {
        logger.warn({ txid }, 'Transaction not found on mempool.space — may not have propagated yet');
        return null; // 404 is not retryable
      }

      // Rate limited or server error — retry
      if (response.status === 429 || response.status >= 500) {
        if (attempt < MEMPOOL_MAX_RETRIES) {
          const delay = MEMPOOL_INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          logger.debug({ txid, attempt, delay, status: response.status }, 'Retrying mempool.space after backoff');
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }

      logger.warn({ txid, status: response.status }, 'Mempool.space API returned error');
      break; // Fall through to fallback
    } catch (error) {
      if (attempt < MEMPOOL_MAX_RETRIES) {
        const delay = MEMPOOL_INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        logger.debug({ txid, attempt, delay, error }, 'Retrying mempool.space after network error');
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      logger.warn({ txid, error }, 'All mempool.space retries exhausted');
      break; // Fall through to fallback
    }
  }

  // ERR-2: Fallback to blockstream.info
  try {
    const fallbackUrl = `${getBlockstreamBaseUrl()}/api/tx/${txid}`;
    logger.info({ txid, fallbackUrl }, 'Falling back to blockstream.info');
    const response = await fetch(fallbackUrl, {
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      return (await response.json()) as MempoolTxResponse;
    }
  } catch (fallbackError) {
    logger.warn({ txid, error: fallbackError }, 'Blockstream.info fallback also failed');
  }

  return null;
}

/**
 * Check all SUBMITTED anchors for confirmation.
 * Called by cron every 2 minutes.
 *
 * Groups anchors by chain_tx_id so Merkle-batched anchors (which share a tx)
 * only require one mempool API call per group. This dramatically improves
 * throughput: 50 tx checks can confirm 1000+ anchors per run.
 */
export async function checkSubmittedConfirmations(): Promise<{ checked: number; confirmed: number }> {
  logger.info('Starting confirmation check for SUBMITTED anchors');

  // PR #753 audit fix A3: serialize BOTH the mock-mode and real-mode paths
  // through the same in-process mutex. Pre-fix, the mock-mode early-return
  // bypassed the mutex check, so two concurrent cron-handler invocations
  // could each generate distinct `txId = mock-batch-${Date.now()}` strings
  // and race the chain_tx_id backfill UPDATE — the loser's webhook payload
  // would carry a tx_id that doesn't match what's in the DB.
  if (confirmationCheckRunning) {
    logger.info('Confirmation check skipped — already in progress');
    return { checked: 0, confirmed: 0 };
  }
  confirmationCheckRunning = true;

  try {
    if (config.useMocks || config.nodeEnv === 'test') {
      return await autoConfirmMockAnchors();
    }
    return await checkSubmittedConfirmationsUnlocked();
  } finally {
    // RACE-3: Always release the in-process mutex, even if an unexpected
    // exception occurs after acquiring it.
    confirmationCheckRunning = false;
  }
}

async function checkSubmittedConfirmationsUnlocked(): Promise<{ checked: number; confirmed: number }> {
  // PERF/C5 + SCRUM-1707: build a bounded unique-tx candidate set from the
  // SUBMITTED backlog, then advance a cursor. A fixed "oldest 500 rows"
  // query can get pinned forever behind old unconfirmed/missing tx groups,
  // preventing later confirmed groups from reaching the drain RPC.
  const candidateResult = await fetchSubmittedTxCandidates();
  const txRows = candidateResult.rows;
  const txError = candidateResult.error;

  if (txError) {
    logger.error({ error: txError }, 'Failed to fetch SUBMITTED anchor tx_ids');
    return { checked: 0, confirmed: 0 };
  }

  if (!txRows || txRows.length === 0) {
    logger.debug('No SUBMITTED anchors to check');
    return { checked: 0, confirmed: 0 };
  }

  // Deduplicate tx_ids and take only MAX_TX_CHECKS_PER_RUN
  const txIds = [...new Set(txRows.map((r) => r.chain_tx_id).filter((id): id is string => id != null))]
    .slice(0, MAX_TX_CHECKS_PER_RUN);

  // Anchors are updated in bulk by chain_tx_id — no in-memory grouping needed

  // CRIT-1: Fetch current chain tip height for confirmation counting
  let currentTipHeight = 0;
  try {
    const baseUrl = getMempoolBaseUrl();
    const tipResp = await fetch(`${baseUrl}/api/blocks/tip/height`, {
      signal: AbortSignal.timeout(10000),
    });
    if (tipResp.ok) {
      currentTipHeight = parseInt(await tipResp.text(), 10);
    }
  } catch {
    logger.warn('Failed to fetch chain tip height — using block-relative confirmations');
  }

  const minConf = getMinConfirmations();
  logger.info(
    {
      uniqueTxIds: txIds.length,
      scannedRows: candidateResult.scannedRows,
      cursorCreatedAt: candidateResult.cursorCreatedAt,
      cursorId: candidateResult.cursorId,
      wrapped: candidateResult.wrapped,
      currentTipHeight,
      minConfirmations: minConf,
    },
    'Checking SUBMITTED anchors grouped by tx_id',
  );

  let confirmed = 0;
  let checked = 0;

  // Process tx groups in parallel batches
  for (let i = 0; i < txIds.length; i += MEMPOOL_CONCURRENCY) {
    const batch = txIds.slice(i, i + MEMPOOL_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (txId) => {
        const txData = await fetchTxStatus(txId);
        checked++;

        if (!txData?.status.confirmed) {
          return 0;
        }

        // Anchors loaded on-demand via bulk update; no in-memory group needed
        const blockHeight = txData.status.block_height ?? 0;
        const blockTimestamp = txData.status.block_time
          ? new Date(txData.status.block_time * 1000).toISOString()
          : new Date().toISOString();

        // CRIT-1: Check if sufficient confirmations reached
        const minConfirmations = getMinConfirmations();
        let confirmations = 1;
        if (blockHeight > 0 && currentTipHeight > 0) {
          confirmations = currentTipHeight - blockHeight + 1;
        }

        if (confirmations < minConfirmations) {
          logger.debug(
            { txId, confirmations, required: minConfirmations },
            `TX confirmed but waiting for ${minConfirmations} confirmations (${confirmations}/${minConfirmations})`,
          );
          return 0;
        }

        // 2026-04-29 hotfix: the previous single-shot bulk UPDATE on 10k
        // rows reliably hit the 60s PostgREST statement_timeout because of
        // BEFORE-UPDATE trigger overhead (5 triggers × 10k rows = 50k
        // function invocations + autovacuum I/O competition). Result:
        // 14-day SECURED gap (Apr 15 -> Apr 29). 1.18M anchors stuck in
        // SUBMITTED on confirmed Bitcoin txs.
        //
        // Fix: call drain_submitted_to_secured_for_tx() RPC which batches
        // the UPDATE in 100-row chunks server-side and returns a count.
        // We loop until the RPC reports no more rows to drain or hits
        // its iteration cap (then we'll pick up the rest on the next cron
        // tick).
        let groupConfirmed = 0;
        const drainedAnchors: SecuredWebhookAnchor[] = [];
        let drainErr: unknown = null;

        // Iterate so a single tick can drain a full 10k-anchor TX in
        // worst case ~10 calls × ~5s each ~= 50s. The new advisory-lock-
        // protected refresh-stats and Cloud Run's 5-min HTTP timeout
        // both leave plenty of headroom.
        const MAX_DRAIN_CALLS = 25;
        for (let drainAttempt = 0; drainAttempt < MAX_DRAIN_CALLS; drainAttempt++) {
          const rpcRes = await db.rpc('drain_submitted_to_secured_for_tx', {
            p_chain_tx_id: txId,
            p_block_height: blockHeight,
            p_block_timestamp: blockTimestamp,
            p_confirmations: confirmations,
            p_batch_size: 100,
            p_max_iterations: 5,
          });
          const data = rpcRes.data;
          const error = rpcRes.error;

          if (error) {
            drainErr = error;
            break;
          }
          const updated = Number(data?.updated ?? 0);
          groupConfirmed += updated;
          drainedAnchors.push(...normalizeDrainedAnchors(data?.anchors));
          // Done draining when the RPC returns fewer than max possible rows.
          if (!data?.capped || updated === 0) break;
        }

        if (drainErr) {
          logger.error({ txId, error: drainErr }, 'Bulk SECURED update failed');
        }

        // Batch audit event — one summary row per org slice instead of
        // per-anchor (8K+ individual audit rows is excessive and slow).
        if (groupConfirmed > 0) {
          const auditRows = buildBatchSecuredAuditRows(
            txId,
            groupConfirmed,
            blockHeight,
            confirmations,
            drainedAnchors,
          );
          const { error: auditErr } =
            auditRows.length === 1
              ? await db.from('audit_events').insert(auditRows[0])
              : await db.from('audit_events').insert(auditRows);
          if (auditErr) logger.warn({ auditErr, txId }, 'Failed to insert batch audit event');

          logger.info(
            { txId, confirmed: groupConfirmed, blockHeight, confirmations },
            'Bulk confirmed anchor group (shared tx)',
          );

          invalidateDrainedVerificationCaches(drainedAnchors);

          // SCRUM-1264 (R2-1): Fan out per-anchor `anchor.secured` webhooks.
          // The pre-2026-03-27 single-anchor path emitted one webhook per
          // SECURED anchor (jobs/anchor.ts:283 still does this for SUBMITTED).
          // Commit a5da008d "perf: bulk SECURED updates" replaced the per-anchor
          // promote with a single bulk UPDATE and skipped the webhook fan-out
          // entirely — silently breaking ~10K customer webhooks per merkle TX
          // for 6 weeks. We restore the contract here, with a concurrency cap
          // to avoid hammering customer endpoints.
          //
          // PR #567 CodeRabbit operational fix: fire-and-forget rather than
          // awaiting inline. A 10K-anchor merkle batch at concurrency=20 with
          // ~1s per dispatch can hold the per-tx Promise.allSettled past the
          // 2-minute cron interval, blocking subsequent runs from clearing
          // their `confirmationCheckRunning` mutex. The helper never throws
          // (errors → DLQ via deliverToEndpoint), so a detached promise is
          // safe; we attach a .catch to surface unexpected throws.
          //
          // Intentionally do not replay per-anchor "secured" emails here. This
          // emergency bulk drain can promote thousands of historical anchors in
          // one cron tick; sending that backlog as user email would create a
          // noisy blast. Webhooks remain the durable integration contract for
          // this backfill path, while the single-anchor path keeps its normal
          // best-effort email behavior.
          if (drainedAnchors.length > 0) {
            const fanOutPromise = fanOutSecuredAnchorWebhooks(drainedAnchors, txId, blockHeight, blockTimestamp);
            void fanOutPromise.catch((fanOutErr) => {
              logger.error(
                { txId, error: fanOutErr },
                'Detached bulk webhook fan-out unexpectedly threw — should never happen (helper catches internally)',
              );
            });
          } else {
            logger.warn(
              { txId, confirmed: groupConfirmed },
              'Bulk webhook fan-out skipped because drain RPC returned no updated anchor identities; refusing to re-query all SECURED anchors for the tx to avoid duplicate webhook replay',
            );
          }
        }

        return groupConfirmed;
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        confirmed += result.value;
      }
    }
  }

  logger.info(
    {
      txChecked: checked,
      anchorsConfirmed: confirmed,
      candidateRows: txRows.length,
      scannedRows: candidateResult.scannedRows,
      cursorCreatedAt: candidateResult.cursorCreatedAt,
      wrapped: candidateResult.wrapped,
    },
    'Confirmation check complete',
  );
  return { checked, confirmed };
}

/**
 * Auto-confirm SUBMITTED anchors in mock/test mode.
 * No mempool.space calls — just promotes all SUBMITTED → SECURED instantly.
 */
async function autoConfirmMockAnchors(): Promise<{ checked: number; confirmed: number }> {
  // SCRUM-1800 (PR #753): the mock path needs to fan out anchor.secured +
  // credential.status_changed webhooks alongside the SUBMITTED→SECURED
  // transition, otherwise staging soaks (which run with USE_MOCKS=true)
  // can't exercise the real-path's bulk-drain webhook code. This kept
  // PR #1264's anchor.secured fan-out and PR #753's credential.status_changed
  // fan-out invisible to every staging soak prior to this fix.
  //
  // Select public_id + org_id alongside id so we can dispatch with the same
  // signature as fanOutSecuredAnchorWebhooks expects.
  const { data: anchors, error } = await db
    .from('anchors')
    .select('id, public_id, org_id, chain_tx_id')
    .eq('status', 'SUBMITTED')
    .is('deleted_at', null)
    .limit(100);

  if (error || !anchors || anchors.length === 0) {
    return { checked: 0, confirmed: 0 };
  }

  const blockHeight = 100000;
  const blockTimestamp = new Date().toISOString();
  const txId = `mock-batch-${Date.now()}`;

  // SCRUM-1800 (PR #753): the `anchors_chain_data_consistency` constraint
  // requires `chain_tx_id IS NOT NULL` whenever status='SECURED'. Some
  // synthetic SUBMITTED rows in the staging seed lack chain_tx_id, which
  // would fail the bulk UPDATE transactionally. Pre-update those rows with
  // a synthetic mock-batch tx_id so the transition can proceed (also
  // ensures fanOutSecuredAnchorWebhooks has a tx_id to attribute the
  // anchor.secured payload to). Mock-mode only — real path doesn't need
  // this because chain submission always sets chain_tx_id before
  // status='SUBMITTED'.
  const idsMissingTxId = anchors
    .filter((a) => !a.chain_tx_id)
    .map((a) => a.id as string);
  if (idsMissingTxId.length > 0) {
    // PR #753 audit fix A3: guard the backfill with `chain_tx_id IS NULL` so
    // a cross-instance race (two worker pods both running this in mock mode)
    // can't overwrite each other's synthetic tx_id. The loser's UPDATE
    // matches zero rows; both proceed to SECURED with their own tx_id in
    // their per-anchor map, but the DB carries the FIRST tick's value.
    const { error: backfillErr } = await db
      .from('anchors')
      .update({ chain_tx_id: txId })
      .in('id', idsMissingTxId)
      .eq('status', 'SUBMITTED')
      .is('chain_tx_id', null);
    if (backfillErr) {
      logger.error(
        { error: backfillErr, count: idsMissingTxId.length },
        'Failed to backfill chain_tx_id on synthetic mock anchors',
      );
      return { checked: anchors.length, confirmed: 0 };
    }
  }

  const ids = anchors.map((a) => a.id as string);
  const { error: updateError } = await db
    .from('anchors')
    .update({
      status: 'SECURED',
      // chain_confirmations: 1, — column pending migration 0068b
      chain_block_height: blockHeight,
      chain_timestamp: blockTimestamp,
    })
    .in('id', ids)
    .eq('status', 'SUBMITTED');

  if (updateError) {
    logger.error({ error: updateError }, 'Failed to auto-confirm mock anchors');
    return { checked: anchors.length, confirmed: 0 };
  }

  logger.info({ count: anchors.length }, 'Auto-confirmed SUBMITTED anchors (mock mode)');

  // Fan out webhooks — same path as the real chain-confirmation route.
  // anchors fetched above carry the public_id + org_id needed by
  // fanOutSecuredAnchorWebhooks; rows with either field null are filtered
  // inside that helper (existing behavior).
  const securedAnchors = anchors.map((a) => ({
    public_id: (a.public_id as string | null) ?? null,
    org_id: (a.org_id as string | null) ?? null,
  }));
  const fanOutPromise = fanOutSecuredAnchorWebhooks(
    securedAnchors,
    txId,
    blockHeight,
    blockTimestamp,
  );
  void fanOutPromise.catch((fanOutErr) => {
    logger.error(
      { txId, error: fanOutErr },
      'Mock-mode webhook fan-out unexpectedly threw — should never happen (helper catches internally)',
    );
  });

  return { checked: anchors.length, confirmed: anchors.length };
}
