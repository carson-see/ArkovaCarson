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

import { db } from '../utils/db.js';
import { invalidateVerificationCache } from '../utils/verifyCache.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { dispatchWebhookEvent } from '../webhooks/delivery.js';
import { runWithConcurrency } from '../utils/concurrency.js';

/** Maximum unique transactions to check per cron run (rate limit mempool.space) */
const MAX_TX_CHECKS_PER_RUN = 100;

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
  event_category: string;
  actor_id: string;
  target_type: string;
  target_id: string;
  org_id: string | null;
  details: string;
};

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
  const rows = orgCounts.map(({ orgId, count }) => ({
    event_type: 'anchor.batch_secured',
    event_category: 'ANCHOR',
    actor_id: '00000000-0000-0000-0000-000000000000',
    target_type: 'anchor',
    target_id: txId,
    org_id: orgId,
    details: `Batch confirmed ${count} anchors at block ${blockHeight} (tx: ${txId}, ${confirmations} confirmations; tx_total: ${groupConfirmed})`,
  }));

  if (rows.length === 0 || unknownCount > 0) {
    rows.push({
      event_type: 'anchor.batch_secured',
      event_category: 'ANCHOR',
      actor_id: '00000000-0000-0000-0000-000000000000',
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

  const tasks = eligible.map((anchor) => async () => {
    await dispatchWebhookEvent(anchor.org_id, 'anchor.secured', anchor.public_id, {
      public_id: anchor.public_id,
      status: 'SECURED',
      chain_tx_id: txId,
      chain_block_height: blockHeight,
      chain_timestamp: blockTimestamp,
      secured_at: blockTimestamp,
    });
  });

  const result = await runWithConcurrency(tasks, BULK_WEBHOOK_FAN_OUT_CONCURRENCY);

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

  // In mock mode, auto-confirm all SUBMITTED anchors
  if (config.useMocks || config.nodeEnv === 'test') {
    return autoConfirmMockAnchors();
  }

  // RACE-3: In-process mutex — prevent concurrent cron runs from overlapping.
  // NOTE: Advisory locks (pg_try_advisory_lock) don't work with Supabase connection
  // pooling (Supavisor/PgBouncer in transaction mode) because each RPC call may
  // use a different PG backend, and advisory locks are per-backend.
  // Since we run a single worker process, an in-memory flag is sufficient.
  if (confirmationCheckRunning) {
    logger.info('Confirmation check skipped — already in progress');
    return { checked: 0, confirmed: 0 };
  }
  confirmationCheckRunning = true;

  try {
    return await checkSubmittedConfirmationsUnlocked();
  } finally {
    // RACE-3: Always release the in-process mutex, even if an unexpected
    // exception occurs after acquiring it.
    confirmationCheckRunning = false;
  }
}

async function checkSubmittedConfirmationsUnlocked(): Promise<{ checked: number; confirmed: number }> {
  // PERF/C5: Fetch chain_tx_id column only, capped at 500 rows.
  // With ~1K records/TX from Merkle batching, 500 rows covers plenty of unique tx_ids.
  // We only need MAX_TX_CHECKS_PER_RUN (100) unique tx_ids per run.
  // Previous: fetched 5000 rows into memory just to find ~100 unique tx_ids.
  const { data: txRows, error: txError } = await db
    .from('anchors')
    .select('chain_tx_id')
    .eq('status', 'SUBMITTED')
    .not('chain_tx_id', 'is', null)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(500);

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
    { uniqueTxIds: txIds.length, currentTipHeight, minConfirmations: minConf },
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
    { txChecked: checked, anchorsConfirmed: confirmed, totalSubmitted: txRows.length },
    'Confirmation check complete',
  );
  return { checked, confirmed };
}

/**
 * Auto-confirm SUBMITTED anchors in mock/test mode.
 * No mempool.space calls — just promotes all SUBMITTED → SECURED instantly.
 */
async function autoConfirmMockAnchors(): Promise<{ checked: number; confirmed: number }> {
  const { data: anchors, error } = await db
    .from('anchors')
    .select('id')
    .eq('status', 'SUBMITTED')
    .is('deleted_at', null)
    .limit(100);

  if (error || !anchors || anchors.length === 0) {
    return { checked: 0, confirmed: 0 };
  }

  const ids = anchors.map((a) => a.id);

  const { error: updateError } = await db
    .from('anchors')
    .update({
      status: 'SECURED',
      // chain_confirmations: 1, — column pending migration 0068b
      chain_block_height: 100000,
      chain_timestamp: new Date().toISOString(),
    })
    .in('id', ids)
    .eq('status', 'SUBMITTED');

  if (updateError) {
    logger.error({ error: updateError }, 'Failed to auto-confirm mock anchors');
    return { checked: anchors.length, confirmed: 0 };
  }

  logger.info({ count: anchors.length }, 'Auto-confirmed SUBMITTED anchors (mock mode)');
  return { checked: anchors.length, confirmed: anchors.length };
}
