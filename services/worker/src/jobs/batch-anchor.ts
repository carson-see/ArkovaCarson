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

import { z } from 'zod';
import { db, withDbTimeout } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { getChainClientAsync } from '../chain/client.js';
import { buildMerkleTree, type MerkleTreeResult } from '../utils/merkle.js';
import { upsertAnchorProofs } from '../utils/anchorProofs.js';
import { getComplianceControlIds } from '../utils/complianceMapping.js';
import { config } from '../config.js';
import { deductOrgCredit, type DeductionResult } from '../utils/orgCredits.js';
import { flagRegistry } from '../middleware/flagRegistry.js';
import type { ChainClient, ChainReceipt, PreparedChainTx } from '../chain/types.js';
import type { Json } from '../types/database.types.js';

/**
 * Max anchors per batch transaction (BTC-001).
 * HARDCODED to 10,000. One Merkle root per TX covers unlimited anchors at the same
 * Bitcoin cost. Small batches waste UTXOs and drain treasury.
 * Env override only allowed to go LOWER (for testing), never below 100.
 */
export const BATCH_SIZE = Math.min(
  Math.max(parseInt(process.env.BATCH_ANCHOR_MAX_SIZE ?? '10000', 10) || 10000, 100),
  10000,
);

/**
 * INEFF-2: Minimum anchors required for batch processing.
 * Lowered from 2 to 1 so ALL anchors benefit from Merkle batching.
 */
export const MIN_BATCH_SIZE = 1;

/**
 * Pipeline rule (operator-defined):
 *   • Below MIN_BATCH_THRESHOLD pending: cron is mostly a no-op, no TX fires.
 *   • At/above MIN_BATCH_THRESHOLD: cron polls on the configured interval
 *     to evaluate the age clock; the 3,000 threshold by itself does NOT fire a TX.
 *   • Hit BATCH_SIZE → fire immediately (Trigger A).
 *   • Oldest pending age ≥ MAX_ANCHOR_AGE_MS → fire whatever is queued
 *     (Trigger B). Even 4,500 anchors at the 3-hour mark broadcasts.
 *   • Daily 3am EST scheduled flush → fire whatever is queued
 *     (Trigger D, see processBatchAnchors call site).
 *
 * MIN_BATCH_THRESHOLD is intentionally NOT a fire trigger — it is the
 * "start watching closely" threshold. The 5-anchors-fires-in-10-min
 * pre-2026-04-28 behavior burned UTXOs on micro-batches.
 */
export const MIN_BATCH_THRESHOLD = 3_000;
export const MAX_ANCHOR_AGE_MS = 3 * 60 * 60 * 1000; // 3 hours

/**
 * SCALE-2: Absolute hard cap for dynamic fee ceiling (sat/vB).
 * Even during severe backlogs, never exceed this rate.
 */
export const ABSOLUTE_FEE_CAP_SAT_PER_VB = 200;

const CLAIM_PENDING_ANCHORS_MIGRATION_COMPAT_SUBSTRINGS = [
  'function not found',
  'could not find the function',
  'does not exist',
  'schema cache',
  'no function matches',
] as const;

interface PendingTriggerProbe {
  pendingCountSentinel: number;
  pendingThreshold: number;
  batchSize: number;
  thresholdCrossed: boolean;
  batchSizeCrossed: boolean;
}

interface ClaimedAnchor {
  id: string;
  fingerprint: string;
  metadata: unknown;
  user_id?: string;
  org_id?: string;
  public_id?: string;
  credential_type?: string;
}

interface ChargedQueueAnchor {
  id: string;
  orgId: string;
}

interface FailedQueueCreditRefund extends ChargedQueueAnchor {
  error: unknown;
  result?: unknown;
}

const QueueAnchorMetadataSchema = z.object({
  credit_denial_reason: z.string().nullable().optional(),
  queue_credit_source: z.literal('org_credits').optional(),
  queue_credit_reason: z.string().min(1).optional(),
  queue_credit_charged_at: z.string().min(1).optional(),
  queue_credit_balance_after: z.number().finite().nullable().optional(),
  queue_credit_denied_at: z.string().min(1).optional(),
  queue_credit_required: z.number().finite().nonnegative().optional(),
  queue_credit_balance: z.number().finite().nullable().optional(),
}).passthrough();

function sanitizedZodIssues(issues: z.ZodIssue[]): Array<{ code: string; path: string[] }> {
  return issues.map((issue) => ({
    code: issue.code,
    path: issue.path.map(String),
  }));
}

function validateQueueAnchorMetadata(
  anchor: ClaimedAnchor,
  metadata: Record<string, unknown>,
  metadataContext: string,
): Record<string, unknown> | null {
  const parsed = QueueAnchorMetadataSchema.safeParse(metadata);
  if (parsed.success) return parsed.data;

  logger.error(
    {
      anchorId: anchor.id,
      orgId: anchor.org_id,
      metadataContext,
      issues: sanitizedZodIssues(parsed.error.issues),
    },
    'Queue-run credit metadata failed schema validation',
  );
  return null;
}

function claimErrorSummary(error: unknown): string {
  if (error == null) return '';
  if (typeof error === 'string') return error.toLowerCase();
  if (typeof error !== 'object') return String(error).toLowerCase();
  const record = error as Record<string, unknown>;
  return [record.code, record.message, record.details, record.hint]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}

function claimPendingAnchorsMigrationCompatMatch(error: unknown): string | null {
  const summary = claimErrorSummary(error);
  if (!summary) return null;

  const code = typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>).code
    : undefined;
  const knownMissingFunctionCode = code === 'PGRST202' || code === '42883';
  if (!knownMissingFunctionCode) return null;

  const mentionsClaimRpc = summary.includes('claim_pending_anchors') || summary.includes('p_org_id');
  if (!mentionsClaimRpc) return null;

  return CLAIM_PENDING_ANCHORS_MIGRATION_COMPAT_SUBSTRINGS.find((substring) => (
    summary.includes(substring)
  )) ?? null;
}

function readMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

function clearClaimMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const next = { ...metadata };
  delete next._claimed_by;
  delete next._claimed_at;
  return next;
}

function queueRunCreditReason(anchor: ClaimedAnchor): string | null {
  if (anchor.credential_type !== 'CONTRACT_POSTSIGNING') return null;
  const metadata = readMetadata(anchor.metadata);
  const ruleActionType = typeof metadata.rule_action_type === 'string'
    ? metadata.rule_action_type
    : null;

  if (ruleActionType === 'AUTO_ANCHOR') {
    return 'rule.auto_anchor_queue_run';
  }

  if (
    ruleActionType === 'FAST_TRACK_ANCHOR' &&
    metadata.credit_denial_reason === 'insufficient_credits'
  ) {
    return 'rule.fast_track_anchor_queue_run';
  }

  return null;
}

function buildQueueRefundError(failed: FailedQueueCreditRefund[], failure: string): Error {
  const failedRefs = failed.map((item) => `${item.id}/${item.orgId}`).join(', ');
  return new Error(
    `refundQueueRunCredits refund_org_credit failed for ${failedRefs} after ${failure}; leaving charged anchors out of normal retry`,
  );
}

async function refundQueueRunCredits(charged: ChargedQueueAnchor[], failure: string): Promise<void> {
  const failed: FailedQueueCreditRefund[] = [];
  await Promise.all(charged.map(async (item) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (db.rpc as any)('refund_org_credit', {
        p_org_id: item.orgId,
        p_amount: 1,
        p_reason: 'rule.queue_anchor_run_compensation',
        p_reference_id: item.id,
      });
      const refunded = !error && (data as { success?: unknown } | null)?.success === true;
      if (!refunded) {
        logger.error(
          { error, result: data, anchorId: item.id, orgId: item.orgId, failure },
          'Queue-run credit refund failed after pre-broadcast failure',
        );
        failed.push({ ...item, error, result: data });
      }
    } catch (err) {
      logger.error(
        { error: err, anchorId: item.id, orgId: item.orgId, failure },
        'Queue-run credit refund threw after pre-broadcast failure',
      );
      failed.push({ ...item, error: err });
    }
  }));
  if (failed.length > 0) {
    logger.error(
      { failedRefunds: failed, failure, totalCharged: charged.length, totalFailed: failed.length },
      'DOUBLE_BILLING_RISK: credit refunds failed — charged anchors must stay out of automatic retry',
    );
    throw buildQueueRefundError(failed, failure);
  }
}

async function markQueueCreditCharged(
  anchor: ClaimedAnchor,
  reason: string,
  deduction: DeductionResult,
  expectedStatus: 'BROADCASTING' | 'PENDING' = 'BROADCASTING',
): Promise<boolean> {
  const metadata = readMetadata(anchor.metadata);
  const nextMetadata = validateQueueAnchorMetadata(anchor, {
    ...metadata,
    credit_denial_reason: null,
    queue_credit_source: 'org_credits',
    queue_credit_reason: reason,
    queue_credit_charged_at: new Date().toISOString(),
    queue_credit_balance_after: deduction.balance ?? null,
  }, 'queue_credit_charged');

  if (!nextMetadata) return false;

  const { error } = await db
    .from('anchors')
    .update({ metadata: nextMetadata as Json })
    .eq('id', anchor.id)
    .eq('status', expectedStatus);

  if (error) {
    logger.error(
      { error, anchorId: anchor.id, orgId: anchor.org_id },
      'Queue-run credit metadata update failed after deduction',
    );
    return false;
  }
  return true;
}

async function releaseQueueCreditDeniedAnchor(
  anchor: ClaimedAnchor,
  reason: string,
  deduction?: DeductionResult,
  expectedStatus: 'BROADCASTING' | 'PENDING' = 'BROADCASTING',
): Promise<void> {
  const metadata = clearClaimMetadata(readMetadata(anchor.metadata));
  const nextMetadata = validateQueueAnchorMetadata(anchor, {
    ...metadata,
    credit_denial_reason: reason,
    queue_credit_denied_at: new Date().toISOString(),
    queue_credit_required: deduction?.required ?? 1,
    queue_credit_balance: deduction?.balance ?? null,
  }, 'queue_credit_denied');

  if (!nextMetadata) return;

  const { error } = await db
    .from('anchors')
    .update({
      status: 'PENDING' as const,
      metadata: nextMetadata as Json,
    })
    .eq('id', anchor.id)
    .eq('status', expectedStatus);

  if (error) {
    logger.error(
      { error, anchorId: anchor.id, orgId: anchor.org_id, reason },
      'Queue-run credit denial release failed',
    );
  }
}

async function applyQueueRunCreditGate(
  claimedAnchors: ClaimedAnchor[],
  expectedStatus: 'BROADCASTING' | 'PENDING' = 'BROADCASTING',
): Promise<{ eligibleAnchors: ClaimedAnchor[]; chargedAnchors: ChargedQueueAnchor[] }> {
  const eligibleAnchors: ClaimedAnchor[] = [];
  const chargedAnchors: ChargedQueueAnchor[] = [];

  for (const anchor of claimedAnchors) {
    const reason = queueRunCreditReason(anchor);
    if (!reason) {
      eligibleAnchors.push(anchor);
      continue;
    }

    if (!anchor.org_id) {
      await releaseQueueCreditDeniedAnchor(anchor, 'missing_org_id', undefined, expectedStatus);
      continue;
    }

    let deduction: DeductionResult;
    try {
      deduction = await deductOrgCredit(db, anchor.org_id, 1, reason, anchor.id);
    } catch (err) {
      logger.error(
        { error: err, anchorId: anchor.id, orgId: anchor.org_id, reason },
        'Queue-run credit deduction threw',
      );
      await releaseQueueCreditDeniedAnchor(anchor, 'credit_rpc_failure', undefined, expectedStatus);
      continue;
    }

    if (!deduction.allowed) {
      await releaseQueueCreditDeniedAnchor(
        anchor,
        deduction.error === 'insufficient_credits'
          ? 'insufficient_credits'
          : deduction.error ?? 'credit_denied',
        deduction,
        expectedStatus,
      );
      continue;
    }

    if (deduction.reason !== 'feature_disabled') {
      const marked = await markQueueCreditCharged(anchor, reason, deduction, expectedStatus);
      if (!marked) {
        await refundQueueRunCredits([{ id: anchor.id, orgId: anchor.org_id }], 'queue credit metadata update failed');
        await releaseQueueCreditDeniedAnchor(anchor, 'credit_metadata_update_failed', undefined, expectedStatus);
        continue;
      }
      chargedAnchors.push({ id: anchor.id, orgId: anchor.org_id });
    }

    eligibleAnchors.push(anchor);
  }

  return { eligibleAnchors, chargedAnchors };
}

// =============================================================================
// ARK-102 (SCRUM-1012): Pinned Trigger A/B/C decision points
// =============================================================================
//
// The batch processor fires a Bitcoin transaction when ANY of three triggers
// is satisfied. The audit tests in `batch-anchor.audit.test.ts` pin the
// behavior of these triggers; the pure functions below make them
// independently testable.

/**
 * Trigger A — Size-based: fire immediately when the claimed count is at or
 * above BATCH_SIZE. Enforced implicitly by the claim loop (see
 * `_processBatchAnchorsInner`), since we never claim more than BATCH_SIZE
 * at once. Helper here is purely for documentation + audit pinning.
 */
export function triggerA_shouldFireOnSize(claimedCount: number): boolean {
  return claimedCount >= BATCH_SIZE;
}

/**
 * Trigger B — Age-based: fire only when BOTH
 *   (a) pendingCount ≥ MIN_BATCH_THRESHOLD (3,000) — the 3-hour clock
 *       only starts running once the queue has crossed the operator-
 *       defined threshold; and
 *   (b) the oldest pending anchor has been waiting ≥ MAX_ANCHOR_AGE_MS
 *       (3 hours).
 *
 * Examples (operator rule, 2026-04-28):
 *   • 1 anchor sitting 6h with no queue growth → does NOT fire (sub-3k).
 *     The daily 3am EST scheduled flush handles long-tail micro-queues.
 *   • 4,500 anchors at 3h → fires (count ≥ 3k AND age ≥ 3h).
 *   • 10,000 anchors at any age → fires via Trigger A, regardless of B.
 *
 * Size alone never fires (that's Trigger A's job). Hitting 3k only means
 * "watch the clock" — the cron just polls every 30 min so the moment age
 * also crosses 3h, the next tick flushes whatever's queued (≥ 3k).
 *
 * Codex review on PR #627 caught the prior version that fired on age
 * alone — a 1-anchor backlog at 3h would have triggered a TX with a
 * single leaf, burning a UTXO for nothing.
 */
export function triggerB_shouldFireOnAge(input: {
  pendingCount: number;
  oldestPendingAgeMs: number;
}): boolean {
  if (input.pendingCount < MIN_BATCH_THRESHOLD) return false;
  return input.oldestPendingAgeMs >= MAX_ANCHOR_AGE_MS;
}

/**
 * Trigger C — Fee-aware: defer the batch when the current fee rate exceeds
 * the dynamic ceiling. The ceiling scales with backlog age so a very-stale
 * backlog still ships, but bounded by ABSOLUTE_FEE_CAP_SAT_PER_VB.
 *
 * Returns the effective ceiling. Caller compares against the live rate.
 */
export function triggerC_computeFeeCeiling(input: {
  baseCeiling: number;
  oldestPendingAgeMs: number;
}): number {
  const THIRTY_MIN = 30 * 60 * 1000;
  const ONE_HOUR = 60 * 60 * 1000;
  let ceiling = input.baseCeiling;
  if (input.oldestPendingAgeMs > ONE_HOUR) ceiling = input.baseCeiling * 4;
  else if (input.oldestPendingAgeMs > THIRTY_MIN) ceiling = input.baseCeiling * 2;
  return Math.min(ceiling, ABSOLUTE_FEE_CAP_SAT_PER_VB);
}

export interface BatchAnchorResult {
  processed: number;
  batchId: string | null;
  merkleRoot: string | null;
  txId: string | null;
}

interface LeafForProof {
  id: string;
  fingerprint: string;
}

/**
 * FIX-1 (SCRUM-2471): persist each leaf's Merkle branch + integer index into
 * `anchor_proofs` so SECURED customer anchors carry a recomputable proof
 * (PROOF-VERIFY / SCRUM-2490 depends on the stored branch). Before this, the
 * customer batch path discarded `tree.proofs` entirely — only
 * `publicRecordAnchor.ts` wrote branches.
 *
 * Non-fatal: the Bitcoin TX is already broadcast by the time this runs, and
 * a failure here is recoverable by the resumable backfill job
 * (`proof-branch-backfill.ts`). We never revert a broadcast over a proof
 * write — that would risk a double-broadcast (anchor-backlog incident
 * 2026-04-24). The PROOF-02 "SECURED ⇒ proof complete" trigger stays gated
 * OFF until the backfill has covered the back-catalogue, so a transient miss
 * here cannot strand an anchor.
 *
 * Single-leaf batches: `buildMerkleTree` returns `root == fingerprint` with
 * an empty branch — persisted as `proofPath: []`, `merkleIndex: 0`,
 * `merkleRoot == fingerprint` (a valid single-leaf inclusion).
 */
async function persistBatchAnchorProofs(
  leaves: LeafForProof[],
  tree: MerkleTreeResult,
  receiptId: string,
  blockHeight: number | null,
  blockTimestamp: string | null,
  batchId: string,
): Promise<void> {
  if (leaves.length === 0) return;
  try {
    const rows = leaves.map((leaf, index) => ({
      anchorId: leaf.id,
      receiptId,
      blockHeight,
      blockTimestamp,
      merkleRoot: tree.root,
      // The leaf's POSITIONAL inclusion branch (S3-P0: correct for duplicate
      // fingerprints; empty for a single-leaf tree). Falls back to the legacy
      // fingerprint-keyed map for older MerkleTreeResult shapes.
      proofPath: tree.proofsByIndex?.[index] ?? tree.proofs.get(leaf.fingerprint) ?? [],
      // Integer leaf index (PROOF-01 merkle_index / PROOF-02 column).
      merkleIndex: index,
      batchId,
    }));
    await upsertAnchorProofs(db, rows);
  } catch (proofError) {
    logger.warn(
      { error: proofError, count: leaves.length, batchId, txId: receiptId },
      'FIX-1: failed to persist customer batch Merkle proofs (non-fatal — recoverable via proof-branch-backfill)',
    );
  }
}

export interface ProcessBatchAnchorOptions {
  /** Bypass economic age/size deferral. Used by daily flush + explicit org queue runs. */
  force?: boolean;
  /** Restrict pending-anchor discovery and claims to a single organization. */
  orgId?: string;
}

/**
 * PostgREST row limit per response. Supabase caps RPC results at 1000 rows.
 * We claim in chunks of this size and accumulate up to BATCH_SIZE.
 */
const POSTGREST_ROW_LIMIT = 1000;

/**
 * SCALE-3: In-process mutex — prevents overlapping batch runs when cron fires
 * faster than batch processing completes. Same pattern as confirmation checker.
 */
let batchProcessingRunning = false;

/**
 * Process pending anchors as a batch using a Merkle tree.
 *
 * Uses claim-before-broadcast pattern:
 * 1. Atomically claim PENDING → BROADCASTING via RPC (chunked to avoid PostgREST 1000-row cap)
 * 2. Build Merkle tree from claimed anchors
 * 3. Publish Merkle root to chain
 * 4. Update each anchor: BROADCASTING → SUBMITTED with tx ID + proof
 *
 * SCALE-1: Smart skip — don't waste UTXOs on tiny batches
 * SCALE-2: Pre-claim fee check with dynamic ceiling based on backlog age
 * SCALE-3: In-process mutex prevents overlapping runs
 */
export async function processBatchAnchors(opts: ProcessBatchAnchorOptions = {}): Promise<BatchAnchorResult> {
  const EMPTY: BatchAnchorResult = { processed: 0, batchId: null, merkleRoot: null, txId: null };

  // S3-P0 / AC7: hard enablement gate. ENABLE_BATCH_ANCHORING is a DB-backed
  // switchboard flag (env fallback, fail-closed — flagRegistry.getFlag returns
  // false for unknown/unloaded flags). OFF ⇒ the job cannot claim, sign,
  // broadcast, or reconcile — even under ?force=true. DEPLOY PREREQUISITE:
  // prod runs the nightly 3am batch drain through this function; the prod
  // switchboard_flags row (or ENABLE_BATCH_ANCHORING env) MUST be verified ON
  // before this change ships, or the drain halts.
  if (!flagRegistry.getFlag('ENABLE_BATCH_ANCHORING')) {
    logger.info('Batch anchoring disabled (ENABLE_BATCH_ANCHORING off) — skipping batch run');
    return EMPTY;
  }

  // SCALE-3: Mutex — skip if already running
  if (batchProcessingRunning) {
    logger.info('Batch processing skipped — already in progress');
    return EMPTY;
  }
  batchProcessingRunning = true;
  try {
    return await _processBatchAnchorsInner(opts);
  } finally {
    batchProcessingRunning = false;
  }
}

// =============================================================================
// S3-P0 — persisted pre-broadcast intent (no-double-broadcast crash-resume)
// =============================================================================
//
// PIPELINE (prepare-capable chain client):
//   Phase 3a  prepareFingerprintTx — build + SIGN, no network. txid is now a
//             pure function of the signed bytes.
//   Phase 3b  persist the intent DURABLY, before any bytes leave the worker:
//             (i)  anchor_proofs rows keyed by the precomputed txid
//                  (receipt_id): merkle branch + merkle_index +
//                  op_return_payload per leaf, and the SIGNED TX HEX inside
//                  raw_response.broadcast_intent on the merkle_index-0 row;
//             (ii) anchors.chain_tx_id = txid on every claimed BROADCASTING
//                  row. recover_stuck_broadcasts (RACE-1) only resets rows
//                  with chain_tx_id IS NULL, so the crash sweep can never
//                  revert an anchor whose tx may already be on the network.
//   Phase 3c  broadcastSignedTx. Outcomes:
//             - success            → Phase 4 (submit_batch_anchors).
//             - RETRYABLE failure  → unknown outcome. LEAVE EVERYTHING —
//               rows stay BROADCASTING+intent; reconcileBroadcastIntents
//               finishes the job next tick (tx found ⇒ finalize; tx unknown
//               ⇒ re-send the SAME bytes ⇒ SAME txid).
//             - NON-retryable reject → the node refused mempool admission;
//               the tx provably never relayed. Only then unwind: refund,
//               delete this txid's proof rows, revert to PENDING.
//
// CRASH MATRIX (worker dies at any point):
//   before 3b  → nothing signed-and-recorded reached the network under a
//                recorded txid; RACE-1 reverts to PENDING; the next batch is
//                the FIRST broadcast. Safe.
//   during 3b  → partial intent; the abort path clears marks + rows (nothing
//                broadcast yet). If the worker dies mid-3b, rows WITH marks
//                are reconciled (tx unknown ⇒ rebroadcast same bytes), rows
//                WITHOUT marks are swept by RACE-1. Either way one txid.
//   after 3b, before/через 3c → reconcile: getReceipt(txid) found ⇒ finalize
//                (NO rebroadcast); not found ⇒ rebroadcast the SAME hex
//                (already-known == success). A batch that broadcast once can
//                NEVER broadcast twice.
//   after 3c, before Phase 4 → reconcile finds the tx ⇒ finalize.
//
// Modeled in machines/bitcoinAnchor.machine.ts (persistBroadcastIntent /
// broadcastResumeFinalize / broadcastIntentReject; INV
// broadcastingIntentChainTxCoupling) — tla-precheck check green.

/** Rows younger than this are assumed to belong to an in-flight run. */
const INTENT_STALE_MINUTES = 5;
const INTENT_CHUNK_SIZE = 500;

interface IntentAnchorRow {
  id: string;
  chain_tx_id: string | null;
  org_id: string | null;
  metadata: unknown;
  credential_type: string | null;
}

export interface IntentReconcileResult {
  scanned: number;
  finalized: number;
  rebroadcast: number;
  rejected: number;
  deferred: number;
}

/** Deterministic batch leaf ordering: (fingerprint asc, anchor id asc). */
function sortAnchorsForBatch(anchors: ClaimedAnchor[]): ClaimedAnchor[] {
  return [...anchors].sort((a, b) => {
    const fp = a.fingerprint.toLowerCase().localeCompare(b.fingerprint.toLowerCase());
    if (fp !== 0) return fp;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Phase 3b(i): durably persist the batch's proof rows + broadcast intent
 * BEFORE broadcasting. THROWS on failure (unlike the legacy post-broadcast
 * FIX-1 write, which is non-fatal) — an intent that is not durable must not
 * be broadcast.
 */
async function persistBroadcastIntentProofs(
  orderedAnchors: ClaimedAnchor[],
  tree: MerkleTreeResult,
  prepared: PreparedChainTx,
  batchId: string,
): Promise<void> {
  const preparedAt = new Date().toISOString();
  const rows = orderedAnchors.map((leaf, index) => ({
    anchorId: leaf.id,
    receiptId: prepared.txId,
    blockHeight: null,
    blockTimestamp: null,
    merkleRoot: tree.root,
    // Positional branch — correct even for duplicate fingerprints (S3-P0).
    proofPath: tree.proofsByIndex[index] ?? [],
    merkleIndex: index,
    batchId,
    // The exact committed payload ("ARKV" + root, no version byte).
    opReturnPayload: prepared.opReturnData,
    // The signed bytes live ONCE, on the index-0 intent row. A signed tx is
    // public data the moment it broadcasts — no key material (§1.4).
    ...(index === 0
      ? {
          rawResponse: {
            broadcast_intent: {
              tx_id: prepared.txId,
              tx_hex: prepared.txHex,
              fee_sats: prepared.feeSats,
              prepared_at: preparedAt,
              batch_id: batchId,
              leaf_count: orderedAnchors.length,
            },
          },
        }
      : {}),
  }));
  await upsertAnchorProofs(db, rows);
}

/** Phase 3b(ii): mark chain_tx_id on the claimed BROADCASTING rows. Throws on failure. */
async function markBroadcastIntent(anchorIds: string[], txId: string): Promise<void> {
  for (let i = 0; i < anchorIds.length; i += INTENT_CHUNK_SIZE) {
    const chunk = anchorIds.slice(i, i + INTENT_CHUNK_SIZE);
    const { error } = await db
      .from('anchors')
      .update({ chain_tx_id: txId })
      .in('id', chunk)
      .eq('status', 'BROADCASTING');
    if (error) {
      throw new Error(`Broadcast-intent mark failed for chunk at ${i}: ${error.message ?? String(error)}`);
    }
  }
}

/** Abort helper: clear intent marks written by markBroadcastIntent (pre-broadcast only). */
async function clearBroadcastIntentMarks(anchorIds: string[], txId: string): Promise<void> {
  for (let i = 0; i < anchorIds.length; i += INTENT_CHUNK_SIZE) {
    const chunk = anchorIds.slice(i, i + INTENT_CHUNK_SIZE);
    try {
      await db
        .from('anchors')
        .update({ chain_tx_id: null })
        .in('id', chunk)
        .eq('status', 'BROADCASTING')
        .eq('chain_tx_id', txId);
    } catch (err) {
      logger.error({ error: err, txId, chunkStart: i }, 'Failed to clear broadcast-intent marks');
    }
  }
}

/** Delete THIS txid's intent/proof rows (definitive-reject or aborted-intent cleanup). */
async function deleteIntentProofRows(anchorIds: string[], txId: string): Promise<void> {
  for (let i = 0; i < anchorIds.length; i += INTENT_CHUNK_SIZE) {
    const chunk = anchorIds.slice(i, i + INTENT_CHUNK_SIZE);
    try {
      await db
        .from('anchor_proofs')
        .delete()
        .in('anchor_id', chunk)
        .eq('receipt_id', txId);
    } catch (err) {
      logger.error({ error: err, txId, chunkStart: i }, 'Failed to delete intent proof rows');
    }
  }
}

/**
 * Positively-identified node/mempool REJECTIONS of a broadcast — the only case
 * where the signed tx provably never relayed, so the batch intent can be safely
 * unwound (refund + revert to PENDING). Matched against Bitcoin Core / mempool
 * reject reasons only.
 */
const BROADCAST_REJECT_PATTERNS = [
  'min relay fee not met', 'mempool min fee not met', 'insufficient fee', 'fee too low',
  'dust', 'bad-txns', 'non-final', 'non-mandatory-script-verify', 'scriptpubkey',
  'txn-mempool-conflict', 'missing-inputs', 'missingorspent', 'tx-size',
  'too-long-mempool-chain', 'absurdly-high-fee', 'min-relay',
];

/**
 * True ONLY when `error` is a definitive node rejection of the signed tx.
 *
 * S3-P0 review HIGH: the unwind (refund + delete intent + revert PENDING) must
 * fire ONLY here. Everything else — auth (401), quota (402), 4xx/5xx, network
 * timeouts, or a post-broadcast bookkeeping error that surfaced AFTER the tx was
 * accepted — is UNKNOWN-outcome: the tx MAY be live, so we DEFER (leave rows
 * BROADCASTING+intent for reconcile) rather than risk a second, different
 * mainnet broadcast. "already known" / "in mempool" / "in block chain" mean the
 * tx IS live — success, never a reject.
 */
function isDefinitiveBroadcastReject(error: unknown): boolean {
  const msg = errMessage(error).toLowerCase();
  if (!msg) return false;
  if (msg.includes('already') || msg.includes('in mempool') || msg.includes('in block chain')) {
    return false;
  }
  return BROADCAST_REJECT_PATTERNS.some((pattern) => msg.includes(pattern));
}

/** Revert intent-marked rows to PENDING, clearing chain_tx_id (definitive reject ONLY). */
async function revertIntentAnchors(anchorIds: string[]): Promise<void> {
  for (let i = 0; i < anchorIds.length; i += INTENT_CHUNK_SIZE) {
    const chunk = anchorIds.slice(i, i + INTENT_CHUNK_SIZE);
    try {
      const { error } = await db
        .from('anchors')
        .update({ status: 'PENDING' as const, chain_tx_id: null })
        .in('id', chunk)
        .eq('status', 'BROADCASTING');
      if (error) {
        logger.error({ error, chunkStart: i }, 'Intent revert chunk failed — rows left BROADCASTING for reconcile');
      }
    } catch (err) {
      logger.error({ error: err, chunkStart: i }, 'Intent revert chunk threw — rows left BROADCASTING for reconcile');
    }
  }
  logger.info({ count: anchorIds.length }, 'Reverted definitively-rejected intent anchors BROADCASTING → PENDING');
}

/** Load the signed tx hex persisted for a txid's broadcast intent. */
async function loadBroadcastIntentHex(txId: string): Promise<string | null> {
  try {
    const { data, error } = await db
      .from('anchor_proofs')
      .select('raw_response')
      .eq('receipt_id', txId)
      .not('raw_response', 'is', null)
      .limit(5);
    if (error || !Array.isArray(data)) return null;
    for (const row of data) {
      const intent = (row as { raw_response?: { broadcast_intent?: { tx_id?: unknown; tx_hex?: unknown } } })
        .raw_response?.broadcast_intent;
      if (
        intent &&
        intent.tx_id === txId &&
        typeof intent.tx_hex === 'string' &&
        /^[0-9a-f]+$/i.test(intent.tx_hex)
      ) {
        return intent.tx_hex;
      }
    }
    return null;
  } catch (err) {
    logger.warn({ error: err, txId }, 'Broadcast-intent lookup failed');
    return null;
  }
}

/**
 * Reconcile-path refund: rows charged pre-broadcast carry
 * queue_credit_source/queue_credit_charged_at markers in metadata
 * (markQueueCreditCharged). Refund those before reverting so the re-claimed
 * batch's fresh deduction never double-charges. Returns the ids whose refund
 * FAILED — those rows must stay BROADCASTING (out of revert) so the refund
 * retries on the next reconcile pass instead of double-charging.
 */
async function refundChargedIntentAnchors(rows: IntentAnchorRow[]): Promise<string[]> {
  const failed: string[] = [];
  for (const row of rows) {
    const metadata = readMetadata(row.metadata);
    const charged =
      metadata.queue_credit_source === 'org_credits' &&
      typeof metadata.queue_credit_charged_at === 'string';
    if (!charged || !row.org_id) continue;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (db.rpc as any)('refund_org_credit', {
        p_org_id: row.org_id,
        p_amount: 1,
        p_reason: 'rule.queue_anchor_run_compensation',
        p_reference_id: row.id,
      });
      const refunded = !error && (data as { success?: unknown } | null)?.success === true;
      if (!refunded) {
        logger.error(
          { error, result: data, anchorId: row.id, orgId: row.org_id },
          'DOUBLE_BILLING_RISK: intent-reconcile credit refund failed — row stays BROADCASTING for retry',
        );
        failed.push(row.id);
      }
    } catch (err) {
      logger.error(
        { error: err, anchorId: row.id, orgId: row.org_id },
        'DOUBLE_BILLING_RISK: intent-reconcile credit refund threw — row stays BROADCASTING for retry',
      );
      failed.push(row.id);
    }
  }
  return failed;
}

/**
 * S3-P0 crash-resume: finish (or safely unwind) batches whose pre-broadcast
 * intent was persisted but whose run died before submit_batch_anchors.
 *
 * Scans stale BROADCASTING rows WITH chain_tx_id (exactly the rows the RACE-1
 * sweep is forbidden to touch), grouped per txid:
 *   - tx known to the chain (mempool or confirmed) → finalize. NO rebroadcast.
 *   - tx unknown + intent hex present → re-send the SAME signed bytes (same
 *     txid; provider treats already-known as success), then finalize.
 *   - definitive (non-retryable) reject → refund + delete intent rows +
 *     revert to PENDING.
 *   - anything uncertain (transient errors, missing hex, RPC failures) →
 *     LEAVE THE ROWS ALONE. Never revert an anchor whose tx might be live.
 *
 * Runs under the batch mutex at the start of every batch tick. Idempotent.
 */
export async function reconcileBroadcastIntents(chainClient: ChainClient): Promise<IntentReconcileResult> {
  const result: IntentReconcileResult = { scanned: 0, finalized: 0, rebroadcast: 0, rejected: 0, deferred: 0 };

  let rows: IntentAnchorRow[];
  try {
    const staleIso = new Date(Date.now() - INTENT_STALE_MINUTES * 60 * 1000).toISOString();
    const res = await db
      .from('anchors')
      .select('id, chain_tx_id, org_id, metadata, credential_type')
      .eq('status', 'BROADCASTING')
      .not('chain_tx_id', 'is', null)
      .is('deleted_at', null)
      .lt('updated_at', staleIso)
      .limit(BATCH_SIZE);
    if (res.error) {
      logger.warn({ error: res.error }, 'Broadcast-intent reconcile scan failed — deferring');
      return result;
    }
    rows = ((res.data ?? []) as IntentAnchorRow[]).filter(
      (r) => typeof r.chain_tx_id === 'string' && r.chain_tx_id.length > 0 && typeof r.id === 'string',
    );
  } catch (err) {
    logger.warn({ error: err }, 'Broadcast-intent reconcile scan threw — deferring');
    return result;
  }

  if (rows.length === 0) return result;
  result.scanned = rows.length;

  const groups = new Map<string, IntentAnchorRow[]>();
  for (const row of rows) {
    const txId = row.chain_tx_id as string;
    if (!groups.has(txId)) groups.set(txId, []);
    groups.get(txId)!.push(row);
  }

  logger.warn(
    { intents: groups.size, anchors: rows.length },
    'Found persisted broadcast intents from an interrupted batch run — reconciling',
  );

  for (const [txId, group] of groups) {
    try {
      await reconcileOneIntent(chainClient, txId, group, result);
    } catch (err) {
      logger.error({ error: err, txId, count: group.length }, 'Broadcast-intent reconcile failed for txid — deferring');
      result.deferred += 1;
    }
  }

  return result;
}

async function reconcileOneIntent(
  chainClient: ChainClient,
  txId: string,
  group: IntentAnchorRow[],
  result: IntentReconcileResult,
): Promise<void> {
  const ids = group.map((r) => r.id);

  // 1. Is the tx already known to the chain (mempool or confirmed)?
  let receipt: ChainReceipt | null;
  try {
    receipt = await chainClient.getReceipt(txId);
  } catch (err) {
    logger.warn({ error: err, txId }, 'Intent reconcile: receipt lookup failed — deferring');
    result.deferred += 1;
    return;
  }

  if (!receipt) {
    // 2. Unknown to the chain — recover the SIGNED BYTES and re-send them.
    //    Never rebuild: a fresh tx would be a SECOND, DIFFERENT broadcast.
    const txHex = await loadBroadcastIntentHex(txId);
    if (!txHex) {
      logger.error(
        { txId, count: ids.length },
        'Intent reconcile: tx unknown to chain and signed hex missing — leaving rows BROADCASTING for manual reconcile (never reverting a possible broadcast)',
      );
      result.deferred += 1;
      return;
    }
    if (typeof chainClient.broadcastSignedTx !== 'function') {
      logger.error({ txId }, 'Intent reconcile: chain client cannot rebroadcast signed bytes — deferring');
      result.deferred += 1;
      return;
    }
    try {
      receipt = await chainClient.broadcastSignedTx(txHex);
      result.rebroadcast += 1;
      logger.info({ txId, count: ids.length }, 'Intent reconcile: rebroadcast the SAME signed bytes');
    } catch (err) {
      if (!isDefinitiveBroadcastReject(err)) {
        // Not a definitive node reject (transient, OR auth/quota/network on a
        // possibly-live tx) — DEFER, never revert (S3-P0 review HIGH).
        logger.warn({ error: errMessage(err), txId }, 'Intent reconcile: rebroadcast outcome unknown (not a definitive reject) — deferring');
        result.deferred += 1;
        return;
      }
      // Definitive reject — the node refused admission; safe to unwind.
      logger.error(
        { error: errMessage(err), txId, count: ids.length },
        'Intent reconcile: broadcast definitively rejected — unwinding intent',
      );
      const refundFailed = await refundChargedIntentAnchors(group);
      const revertIds = ids.filter((id) => !refundFailed.includes(id));
      await deleteIntentProofRows(revertIds, txId);
      await revertIntentAnchors(revertIds);
      result.rejected += 1;
      return;
    }
  }

  // 3. Finalize: same DB write as the happy path (BROADCASTING → SUBMITTED).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: submitError } = await (db.rpc as any)('submit_batch_anchors', {
    p_anchor_ids: ids,
    p_tx_id: txId,
    p_block_height: receipt.blockHeight ?? null,
    p_block_timestamp: receipt.blockTimestamp ?? null,
    p_merkle_root: null,
    p_batch_id: null,
  });
  if (submitError) {
    logger.error({ error: submitError, txId }, 'Intent reconcile: submit_batch_anchors failed — deferring (intent intact)');
    result.deferred += 1;
    return;
  }
  result.finalized += 1;
  logger.info({ txId, count: ids.length }, 'Intent reconcile: finalized interrupted batch BROADCASTING → SUBMITTED');
}

/** PII-safe error message extraction (txid/blockhash/error text only — §1.4). */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function _processBatchAnchorsInner(opts: ProcessBatchAnchorOptions = {}): Promise<BatchAnchorResult> {
  const EMPTY: BatchAnchorResult = { processed: 0, batchId: null, merkleRoot: null, txId: null };
  const orgId = typeof opts.orgId === 'string' ? opts.orgId.trim() : null;
  if (opts.orgId !== undefined && !orgId) {
    logger.error({ orgId: opts.orgId }, 'Invalid empty orgId for org-scoped batch processing');
    return EMPTY;
  }

  // Phase 0a: Pre-flight UTXO check — skip immediately if treasury is empty.
  const chainClient = await getChainClientAsync();

  // S3-P0 Phase -1: finish (or safely unwind) any interrupted batch whose
  // pre-broadcast intent survived a crash, BEFORE claiming new work. Runs
  // under the same mutex; never throws (defers on any uncertainty).
  try {
    const reconcile = await reconcileBroadcastIntents(chainClient);
    if (reconcile.scanned > 0) {
      logger.info({ ...reconcile }, 'Broadcast-intent reconcile pass complete');
    }
  } catch (err) {
    logger.warn({ error: err }, 'Broadcast-intent reconcile pass threw — continuing batch run');
  }

  try {
    if (chainClient.hasFunds) {
      const funded = await chainClient.hasFunds();
      if (!funded) {
        logger.warn('Treasury empty — skipping batch anchor processing until funded');
        return EMPTY;
      }
    }
  } catch (err) {
    logger.warn({ error: err }, 'Pre-flight UTXO check failed — proceeding cautiously');
  }

  // Phase 0b: SCALE-1 — Smart batch skip + backlog age check
  let oldestPendingAgeMs = 0;
  try {
    // These reads are independent; keep them bounded to indexed threshold
    // probes rather than exact counts on the hot anchors table.
    let oldestQuery = db
      .from('anchors')
      .select('created_at')
      .eq('status', 'PENDING')
      .is('deleted_at', null);
    if (orgId) oldestQuery = oldestQuery.eq('org_id', orgId);

    const [oldestRes, countsRes] = await Promise.all([
      oldestQuery
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle(),
      getPendingTriggerProbe(orgId ?? undefined),
    ]);

    const stats = oldestRes.data;
    if (!stats) {
      logger.debug('No pending anchors — skipping batch');
      return EMPTY;
    }

    oldestPendingAgeMs = Date.now() - new Date(stats.created_at).getTime();

    if (countsRes.error) {
      logger.warn({ error: countsRes.error }, 'Pending threshold probe failed');
    }
    const pendingProbe = countsRes.data ?? {
      pendingCountSentinel: 1,
      pendingThreshold: MIN_BATCH_THRESHOLD,
      batchSize: BATCH_SIZE,
      thresholdCrossed: false,
      batchSizeCrossed: false,
    };
    const pendingCount = pendingProbe.pendingCountSentinel;
    const pendingCountLogContext = {
      pendingCountSentinel: pendingCount,
      pendingCountSource: orgId ? 'org_threshold_probe' : 'global_threshold_probe',
      pendingThreshold: MIN_BATCH_THRESHOLD,
      batchSize: BATCH_SIZE,
      pendingThresholdCrossed: pendingProbe.thresholdCrossed,
      batchSizeCrossed: pendingProbe.batchSizeCrossed,
    };

    // Trigger D: forced flush (daily 3am EST sweep) bypasses the age check
    // and broadcasts whatever is queued, even below MIN_BATCH_THRESHOLD.
    // Used by the daily-anchor-flush Cloud Scheduler job.
    if (opts.force) {
      logger.info(
        { ...pendingCountLogContext, oldestAgeMs: oldestPendingAgeMs, orgId },
        orgId ? 'Forced org batch flush' : 'Forced batch flush (daily 3am EST sweep)',
      );
    } else if (triggerA_shouldFireOnSize(pendingCount)) {
      logger.info(
        { ...pendingCountLogContext, oldestAgeMs: oldestPendingAgeMs, orgId },
        orgId ? 'Org batch size trigger fired' : 'Batch size trigger fired',
      );
    } else if (!triggerB_shouldFireOnAge({ pendingCount, oldestPendingAgeMs })) {
      logger.debug(
        { ...pendingCountLogContext, oldestAgeMs: oldestPendingAgeMs, orgId },
        'Batch trigger not met — deferring',
      );
      return EMPTY;
    }
  } catch (err) {
    logger.warn({ error: err }, 'Smart batch skip check failed — proceeding with batch');
  }

  // Phase 0c: SCALE-2 — Pre-claim fee check with dynamic ceiling
  try {
    if (chainClient.estimateCurrentFee) {
      const currentFee = await chainClient.estimateCurrentFee();
      const baseCeiling = config.maxFeeThresholdSatPerVbyte ?? 50;
      const effectiveCeiling = triggerC_computeFeeCeiling({ baseCeiling, oldestPendingAgeMs });

      if (currentFee > effectiveCeiling) {
        logger.warn(
          { currentFee, effectiveCeiling, baseCeiling, oldestPendingAgeMs },
          'Fee rate exceeds ceiling — deferring batch until fees drop',
        );
        return EMPTY;
      }

      logger.debug({ currentFee, effectiveCeiling }, 'Fee pre-check passed');
    }
  } catch (err) {
    logger.warn({ error: err }, 'Pre-claim fee check failed — proceeding cautiously');
  }

  // Phase 1: Claim anchors in chunks (PostgREST caps RPC responses at 1000 rows)
  const allClaimed: ClaimedAnchor[] = [];
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
        p_org_id: orgId,
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
        const migrationCompatMatch = claimPendingAnchorsMigrationCompatMatch(claimError);
        if (migrationCompatMatch) {
          logger.warn(
            { error: claimError, migrationCompatMatch },
            'claim_pending_anchors RPC unavailable — falling back to legacy batch',
          );
          return legacyProcessBatchAnchors(orgId ?? undefined);
        }
        logger.error({ error: claimError }, 'claim_pending_anchors RPC failed — skipping batch without legacy fallback');
        return EMPTY;
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
  const { eligibleAnchors: broadcastAnchors, chargedAnchors } = await applyQueueRunCreditGate(claimedAnchors);

  if (broadcastAnchors.length < MIN_BATCH_SIZE) {
    if (broadcastAnchors.length > 0) {
      await refundQueueRunCredits(chargedAnchors, 'below minimum batch size after queue credit gate');
      await bulkRevertToPending(broadcastAnchors.map(a => a.id));
    }
    return { processed: 0, batchId: null, merkleRoot: null, txId: null };
  }

  logger.info(
    { claimed: claimedAnchors.length, eligible: broadcastAnchors.length, target: BATCH_SIZE },
    'Claimed anchors for batch processing',
  );

  // Phase 2: Build Merkle tree over the DETERMINISTICALLY-ORDERED leaf set.
  // S3-P0 leaf-ordering contract: (fingerprint asc, anchor id asc) — the
  // committed root is a pure function of the claimed leaf SET, independent of
  // claim-RPC return order (documented in utils/merkle.ts).
  const orderedAnchors = sortAnchorsForBatch(broadcastAnchors);
  const fingerprints = orderedAnchors.map((a: { fingerprint: string }) => a.fingerprint);
  const tree = buildMerkleTree(fingerprints);

  const batchId = `batch_${Date.now()}_${orderedAnchors.length}`;
  const anchorIds = orderedAnchors.map((a: { id: string }) => a.id);

  // Phase 3: ONE OP_RETURN tx per batch committing the ROOT (ARKV marker).
  //
  // Intent path (S3-P0, prepare-capable client — BitcoinChainClient AND
  // MockChainClient): sign → persist intent → broadcast. See the pipeline
  // comment above reconcileBroadcastIntents for the full crash matrix.
  //
  // Legacy path (clients without prepare support): single-call
  // submitFingerprint, post-broadcast proof persistence — unchanged behavior.
  const intentCapable =
    typeof chainClient.prepareFingerprintTx === 'function' &&
    typeof chainClient.broadcastSignedTx === 'function';

  let receipt: ChainReceipt;
  let intentPersisted = false;

  if (intentCapable) {
    // ── Phase 3a: build + sign (no network) ──
    let prepared: PreparedChainTx;
    try {
      prepared = await chainClient.prepareFingerprintTx!({
        fingerprint: tree.root,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      // Nothing signed was persisted, nothing broadcast — safe full revert.
      logger.error(
        { error: errMessage(error), merkleRoot: tree.root, count: orderedAnchors.length },
        'Batch tx preparation failed — bulk reverting claims',
      );
      await refundQueueRunCredits(chargedAnchors, 'batch tx preparation failed');
      await bulkRevertToPending(anchorIds);
      return { processed: 0, batchId: null, merkleRoot: tree.root, txId: null };
    }

    // AC2 hard assertion: ARKV(4) + root(32) [+ metadata] must fit OP_RETURN.
    if (prepared.opReturnData.length / 2 > 80) {
      logger.error(
        { payloadBytes: prepared.opReturnData.length / 2, merkleRoot: tree.root },
        'Batch OP_RETURN payload exceeds 80 bytes — aborting before intent persistence',
      );
      await refundQueueRunCredits(chargedAnchors, 'oversized OP_RETURN payload');
      await bulkRevertToPending(anchorIds);
      return { processed: 0, batchId: null, merkleRoot: tree.root, txId: null };
    }

    // ── Phase 3b: persist the broadcast intent DURABLY, pre-network ──
    try {
      await persistBroadcastIntentProofs(orderedAnchors, tree, prepared, batchId);
      await markBroadcastIntent(anchorIds, prepared.txId);
      intentPersisted = true;
    } catch (error) {
      // Intent persistence incomplete — NOTHING has been broadcast, so a
      // full unwind is safe: clear any partial marks/rows, refund, revert.
      logger.error(
        { error: errMessage(error), txId: prepared.txId, count: orderedAnchors.length },
        'Broadcast-intent persistence failed — unwinding (nothing was broadcast)',
      );
      await clearBroadcastIntentMarks(anchorIds, prepared.txId);
      await deleteIntentProofRows(anchorIds, prepared.txId);
      await refundQueueRunCredits(chargedAnchors, 'broadcast-intent persistence failed');
      await bulkRevertToPending(anchorIds);
      return { processed: 0, batchId: null, merkleRoot: tree.root, txId: null };
    }

    // ── Phase 3c: broadcast the signed bytes ──
    try {
      receipt = await chainClient.broadcastSignedTx!(prepared.txHex);
    } catch (error) {
      if (!isDefinitiveBroadcastReject(error)) {
        // UNKNOWN OUTCOME — the tx may or may not have reached the network
        // (transient failure, OR a provider-level auth/quota/network error, OR a
        // post-broadcast bookkeeping throw). The intent is durable: leave rows
        // BROADCASTING+chain_tx_id and let reconcileBroadcastIntents finish next
        // tick. NEVER revert here — a revert would re-claim and broadcast a
        // SECOND, DIFFERENT tx (S3-P0 review HIGH — defer by default).
        logger.warn(
          { error: errMessage(error), txId: prepared.txId, count: orderedAnchors.length },
          'Batch broadcast outcome unknown (not a definitive reject) — intent persisted; reconcile will finalize or rebroadcast the SAME bytes next tick',
        );
        return { processed: 0, batchId, merkleRoot: tree.root, txId: prepared.txId };
      }
      // DEFINITIVE reject — the node refused mempool admission; the signed tx
      // provably never relayed. Safe to unwind the intent completely.
      logger.error(
        { error: errMessage(error), txId: prepared.txId, count: orderedAnchors.length },
        'Batch broadcast definitively rejected — unwinding intent',
      );
      // Refund FIRST: if a refund fails this throws, leaving rows
      // BROADCASTING+intent so the reconcile retries the refund via metadata
      // instead of a revert double-charging on re-claim.
      await refundQueueRunCredits(chargedAnchors, 'batch broadcast definitively rejected');
      await deleteIntentProofRows(anchorIds, prepared.txId);
      await revertIntentAnchors(anchorIds);
      return { processed: 0, batchId: null, merkleRoot: tree.root, txId: null };
    }

    // Normalize: an empty provider txid (already-known == success) falls back
    // to the precomputed txid of the signed bytes.
    if (!receipt || !receipt.receiptId) {
      receipt = { ...(receipt ?? { blockHeight: 0, blockTimestamp: new Date().toISOString(), confirmations: 0 }), receiptId: prepared.txId };
    }
  } else {
    // ── Legacy path: single-call broadcast (no intent persistence) ──
    let legacyReceipt: ChainReceipt;
    try {
      legacyReceipt = await chainClient.submitFingerprint({
        fingerprint: tree.root,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error({ error, merkleRoot: tree.root, count: orderedAnchors.length }, 'Batch anchor chain submission failed — bulk reverting claims');
      await refundQueueRunCredits(chargedAnchors, 'chain submission failed');
      await bulkRevertToPending(anchorIds);
      return { processed: 0, batchId: null, merkleRoot: tree.root, txId: null };
    }

    if (!legacyReceipt || !legacyReceipt.receiptId) {
      logger.error({ merkleRoot: tree.root }, 'Batch chain broadcast returned empty receipt — bulk reverting claims');
      await refundQueueRunCredits(chargedAnchors, 'chain submission returned empty receipt');
      await bulkRevertToPending(anchorIds);
      return { processed: 0, batchId: null, merkleRoot: tree.root, txId: null };
    }
    receipt = legacyReceipt;
  }

  // Phase 4: Bulk update all claimed anchors BROADCASTING → SUBMITTED in one RPC call
  // (Individual PostgREST updates timeout under load — use DB-side bulk function)

  const submitParams = {
    p_anchor_ids: anchorIds,
    p_tx_id: receipt.receiptId,
    p_block_height: receipt.blockHeight ?? null,
    p_block_timestamp: receipt.blockTimestamp ?? null,
    p_merkle_root: tree.root,
    p_batch_id: batchId,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: firstCount, error: bulkError } = await (db.rpc as any)('submit_batch_anchors', submitParams);

  let updatedCount: number | null = typeof firstCount === 'number' ? firstCount : null;

  if (bulkError) {
    // The Bitcoin TX is already broadcast (receipt.receiptId is set). Reverting
    // the claim to PENDING here would cause the next cron tick to re-claim and
    // broadcast a SECOND, DIFFERENT TX for the same fingerprints, wasting
    // treasury sats (anchor-backlog incident 2026-04-24). Instead:
    //   1. Retry submit_batch_anchors once — transient statement-timeouts are
    //      the most common failure under load.
    //   2. If the retry also fails, fall back to chunked direct UPDATEs that
    //      record chain_tx_id so recover_stuck_broadcasts() (which only
    //      reverts rows where chain_tx_id IS NULL) leaves them alone. This
    //      accepts slight metadata staleness in exchange for never
    //      double-broadcasting.
    logger.warn(
      { error: bulkError, txId: receipt.receiptId, count: broadcastAnchors.length },
      'submit_batch_anchors RPC failed — retrying before fallback (prevents double-broadcast)',
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const retry = await (db.rpc as any)('submit_batch_anchors', submitParams);
    if (!retry.error) {
      const count = typeof retry.data === 'number' ? retry.data : broadcastAnchors.length;
      logger.info({ txId: receipt.receiptId, count }, 'submit_batch_anchors succeeded on retry');
      updatedCount = count;
    } else {
      logger.error(
        { error: retry.error, txId: receipt.receiptId, count: broadcastAnchors.length },
        'submit_batch_anchors failed twice — falling back to direct SUBMITTED updates (do NOT revert to PENDING)',
      );
      updatedCount = await bulkMarkSubmittedFallback(
        anchorIds,
        receipt.receiptId,
        receipt.blockHeight ?? null,
        receipt.blockTimestamp ?? null,
      );
    }
  }

  const processed = typeof updatedCount === 'number' ? updatedCount : broadcastAnchors.length;

  // FIX-1 (SCRUM-2471): persist each leaf's Merkle branch + integer index.
  // S3-P0: on the intent path this ALREADY happened durably in Phase 3b
  // (pre-broadcast) — do not re-write. Legacy path keeps the post-broadcast
  // non-fatal write. `orderedAnchors` order == the leaf order passed to
  // buildMerkleTree, so the array index == the leaf's merkle_index.
  if (!intentPersisted) {
    await persistBatchAnchorProofs(
      orderedAnchors.map((a) => ({ id: a.id, fingerprint: a.fingerprint })),
      tree,
      receipt.receiptId,
      receipt.blockHeight ?? null,
      receipt.blockTimestamp ?? null,
      batchId,
    );
  }

  // CML-02: Populate compliance_controls per credential type (non-fatal post-processing)
  try {
    const byType = new Map<string | null, string[]>();
    for (const anchor of orderedAnchors) {
      const ct = (anchor as { credential_type?: string | null }).credential_type ?? null;
      if (!byType.has(ct)) byType.set(ct, []);
      byType.get(ct)!.push(anchor.id);
    }
    for (const [credType, ids] of byType) {
      const controls = getComplianceControlIds(credType);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).from('anchors').update({ compliance_controls: controls }).in('id', ids);
    }
  } catch (complianceErr) {
    logger.warn({ error: complianceErr }, 'Non-fatal: failed to set compliance_controls on batch anchors');
  }

  logger.info(
    {
      batchId,
      count: processed,
      total: broadcastAnchors.length,
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

async function getPendingTriggerProbe(orgId?: string): Promise<{ data: PendingTriggerProbe | null; error: unknown }> {
  try {
    // We only need to know whether the queue crossed Trigger A/B thresholds;
    // avoid exact counts because they scan the hot anchors table. The returned
    // pending value is a trigger sentinel, not a literal count.
    const probeAt = (offset: number) => {
      let query = db
        .from('anchors')
        .select('id')
        .eq('status', 'PENDING')
        .is('deleted_at', null);
      if (orgId) query = query.eq('org_id', orgId);
      return query
        .order('created_at', { ascending: true })
        .range(offset, offset)
        .maybeSingle();
    };

    const [thresholdRes, batchSizeRes] = await Promise.all([
      probeAt(MIN_BATCH_THRESHOLD - 1),
      probeAt(BATCH_SIZE - 1),
    ]);
    if (thresholdRes.error) return { data: null, error: thresholdRes.error };
    if (batchSizeRes.error) return { data: null, error: batchSizeRes.error };

    const batchSizeCrossed = !!batchSizeRes.data;
    const thresholdCrossed = batchSizeCrossed || !!thresholdRes.data;
    const pendingCountSentinel = batchSizeCrossed
      ? BATCH_SIZE
      : thresholdCrossed
        ? MIN_BATCH_THRESHOLD
        : 1;
    return {
      data: {
        pendingCountSentinel,
        pendingThreshold: MIN_BATCH_THRESHOLD,
        batchSize: BATCH_SIZE,
        thresholdCrossed,
        batchSizeCrossed,
      },
      error: null,
    };
  } catch (error) {
    return { data: null, error };
  }
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
 * Post-broadcast fallback when `submit_batch_anchors` RPC fails twice.
 *
 * The Bitcoin TX has already been broadcast at this point, so reverting to
 * PENDING would cause the next cron tick to broadcast a SECOND, DIFFERENT TX
 * for the same fingerprints (double-spend of treasury sats).
 *
 * Instead we push the claimed anchors BROADCASTING → SUBMITTED via chunked
 * direct UPDATEs, recording `chain_tx_id` so `recover_stuck_broadcasts()`
 * (which only resets rows where `chain_tx_id IS NULL`) ignores them and
 * the confirmation-check cron can finalize them to SECURED normally.
 *
 * Does NOT touch metadata. The `prevent_metadata_edit_after_secured` trigger
 * allows status-change-only updates without mutating metadata; keeping the
 * existing metadata (including `_claimed_by` residue from the claim step)
 * is harmless.
 */
async function bulkMarkSubmittedFallback(
  anchorIds: string[],
  txId: string,
  blockHeight: number | null,
  blockTimestamp: string | null,
): Promise<number> {
  const CHUNK_SIZE = 500;
  let updated = 0;
  for (let i = 0; i < anchorIds.length; i += CHUNK_SIZE) {
    const chunk = anchorIds.slice(i, i + CHUNK_SIZE);
    try {
      const { error, count } = await db
        .from('anchors')
        .update(
          {
            status: 'SUBMITTED' as const,
            chain_tx_id: txId,
            chain_block_height: blockHeight,
            chain_timestamp: blockTimestamp,
          },
          { count: 'exact' },
        )
        .in('id', chunk)
        .eq('status', 'BROADCASTING');
      if (error) {
        logger.error(
          { error, chunkStart: i, chunkSize: chunk.length, txId },
          'Fallback mark-submitted chunk failed — rows left in BROADCASTING (will be picked up by recover_stuck_broadcasts once chain_tx_id is set)',
        );
        continue;
      }
      updated += count ?? 0;
    } catch (err) {
      logger.error(
        { error: err, chunkStart: i, txId },
        'Fallback mark-submitted chunk threw — rows left in BROADCASTING',
      );
    }
  }
  logger.warn(
    { count: updated, total: anchorIds.length, txId },
    'Fallback-marked BROADCASTING → SUBMITTED with tx_id (post-broadcast RPC failure recovery)',
  );
  return updated;
}

/**
 * Bulk revert anchors from BROADCASTING to PENDING using batched IN queries.
 * Much faster than individual updates — prevents 504 timeouts on large batches.
 *
 * Use ONLY when chain broadcast itself failed (no tx_id was produced). DO NOT
 * use after a successful broadcast — that would cause double-broadcast on the
 * next cron tick. See `bulkMarkSubmittedFallback` for the post-broadcast path.
 */
async function bulkRevertToPending(anchorIds: string[]): Promise<void> {
  const CHUNK_SIZE = 500;
  for (let i = 0; i < anchorIds.length; i += CHUNK_SIZE) {
    const chunk = anchorIds.slice(i, i + CHUNK_SIZE);
    try {
      const { error } = await db
        .from('anchors')
        .update({ status: 'PENDING' })
        .in('id', chunk)
        .eq('status', 'BROADCASTING');
      if (error) {
        logger.error({ error, chunkStart: i, chunkSize: chunk.length }, 'Bulk revert chunk failed — falling back to individual');
        for (const id of chunk) {
          await revertBatchAnchorToPending(id);
        }
      }
    } catch (err) {
      logger.error({ error: err, chunkStart: i }, 'Bulk revert chunk threw — falling back to individual');
      for (const id of chunk) {
        await revertBatchAnchorToPending(id);
      }
    }
  }
  logger.info({ count: anchorIds.length }, 'Bulk reverted BROADCASTING → PENDING');
}

/**
 * Legacy fallback: batch processing without claim RPC.
 * Used when migration 0111 hasn't been applied yet.
 */
async function legacyProcessBatchAnchors(orgId?: string): Promise<BatchAnchorResult> {
  let pendingQuery = db
    .from('anchors')
    .select('id, fingerprint, metadata, credential_type, org_id, user_id, public_id')
    .eq('status', 'PENDING')
    .is('deleted_at', null)
    .is('chain_tx_id', null);
  if (orgId) pendingQuery = pendingQuery.eq('org_id', orgId);

  const { data: pendingAnchors, error: fetchError } = await pendingQuery
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (fetchError) {
    logger.error({ error: fetchError }, 'Failed to fetch pending anchors for batch');
    return { processed: 0, batchId: null, merkleRoot: null, txId: null };
  }

  if (!pendingAnchors || pendingAnchors.length < MIN_BATCH_SIZE) {
    return { processed: 0, batchId: null, merkleRoot: null, txId: null };
  }

  const { eligibleAnchors, chargedAnchors } = await applyQueueRunCreditGate(
    pendingAnchors as ClaimedAnchor[],
    'PENDING',
  );

  if (eligibleAnchors.length < MIN_BATCH_SIZE) {
    await refundQueueRunCredits(chargedAnchors, 'legacy batch below minimum after queue credit gate');
    return { processed: 0, batchId: null, merkleRoot: null, txId: null };
  }

  // S3-P0: same deterministic leaf ordering as the main path.
  const broadcastAnchors = sortAnchorsForBatch(eligibleAnchors);
  const fingerprints = broadcastAnchors.map((a) => a.fingerprint);
  const tree = buildMerkleTree(fingerprints);

  let receipt;
  try {
    const chainClient = await getChainClientAsync();
    receipt = await chainClient.submitFingerprint({
      fingerprint: tree.root,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({ error, merkleRoot: tree.root }, 'Legacy batch chain submission failed');
    await refundQueueRunCredits(chargedAnchors, 'legacy chain submission failed');
    return { processed: 0, batchId: null, merkleRoot: tree.root, txId: null };
  }

  const batchId = `batch_${Date.now()}_${broadcastAnchors.length}`;
  const anchorIds = broadcastAnchors.map((a) => a.id);

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

    for (const anchor of broadcastAnchors) {
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
          compliance_controls: getComplianceControlIds(anchor.credential_type),
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

    // FIX-1 (SCRUM-2471): persist branches even on the legacy fallback path.
    await persistBatchAnchorProofs(
      broadcastAnchors.map((a) => ({ id: a.id, fingerprint: a.fingerprint })),
      tree,
      receipt.receiptId,
      receipt.blockHeight ?? null,
      receipt.blockTimestamp ?? null,
      batchId,
    );

    logger.info({ batchId, count: updatedCount, total: broadcastAnchors.length, merkleRoot: tree.root, txId: receipt.receiptId }, 'Legacy batch anchor processing complete (fallback)');
    return { processed: updatedCount, batchId, merkleRoot: tree.root, txId: receipt.receiptId };
  }

  const processed = typeof bulkCount === 'number' ? bulkCount : broadcastAnchors.length;

  // FIX-1 (SCRUM-2471): persist branches on the legacy RPC-success path.
  await persistBatchAnchorProofs(
    broadcastAnchors.map((a) => ({ id: a.id, fingerprint: a.fingerprint })),
    tree,
    receipt.receiptId,
    receipt.blockHeight ?? null,
    receipt.blockTimestamp ?? null,
    batchId,
  );

  logger.info(
    { batchId, count: processed, total: broadcastAnchors.length, merkleRoot: tree.root, txId: receipt.receiptId },
    'Legacy batch anchor processing complete',
  );

  return { processed, batchId, merkleRoot: tree.root, txId: receipt.receiptId };
}
