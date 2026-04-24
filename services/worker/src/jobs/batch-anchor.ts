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

import { db, withDbTimeout } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { getChainClient } from '../chain/client.js';
import { buildMerkleTree } from '../utils/merkle.js';
import { getComplianceControlIds } from '../utils/complianceMapping.js';
import { upsertAnchorProofs } from '../utils/anchorProofs.js';
import { config } from '../config.js';
import { POSTGREST_ROW_LIMIT, resolveAnchorBatchSize } from './anchor-batching.js';
import type { ChainReceipt } from '../chain/types.js';

/**
 * Max anchors per batch transaction (BTC-001).
 * HARDCODED to 10,000. One Merkle root per TX covers unlimited anchors at the same
 * Bitcoin cost. Small batches waste UTXOs and drain treasury.
 * Env override only allowed to go LOWER (for testing), never below 100.
 */
export const BATCH_SIZE = Math.min(
  resolveAnchorBatchSize(config.batchAnchorMaxSize),
  10000,
);

/**
 * INEFF-2: Minimum anchors required for batch processing.
 * Lowered from 2 to 1 so ALL anchors benefit from Merkle batching.
 */
export const MIN_BATCH_SIZE = 1;

/**
 * SCALE-1: Smart batch skipping — don't burn a UTXO + fee for tiny batches.
 * Skip if fewer than this many anchors pending AND oldest is under MAX_ANCHOR_AGE_MS.
 * Guarantees no anchor waits more than MAX_ANCHOR_AGE_MS regardless.
 */
export const MIN_BATCH_THRESHOLD = 5;
export const MAX_ANCHOR_AGE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * SCALE-2: Absolute hard cap for dynamic fee ceiling (sat/vB).
 * Even during severe backlogs, never exceed this rate.
 */
export const ABSOLUTE_FEE_CAP_SAT_PER_VB = 200;

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
 * above BATCH_SIZE.
 *
 * CIBA-HARDEN-05: this function is NEVER CALLED from the production path.
 * The claim loop in `_processBatchAnchorsInner` enforces the invariant
 * structurally — each claim chunk is capped by `remaining = BATCH_SIZE -
 * total`, so the accumulated total converges on BATCH_SIZE without needing
 * a separate guard. The export exists only so the audit test
 * `batch-anchor.audit.test.ts` can pin the Trigger A decision rule
 * independently of the loop implementation. Before removing this export,
 * update the audit test to inspect BATCH_SIZE directly.
 */
export function triggerA_shouldFireOnSize(claimedCount: number): boolean {
  return claimedCount >= BATCH_SIZE;
}

/**
 * Trigger B — Age-based: even if pending count is below MIN_BATCH_THRESHOLD,
 * force a batch when the oldest pending anchor has been waiting longer than
 * MAX_ANCHOR_AGE_MS. Guarantees no anchor sits PENDING for more than that
 * window (modulo cron cadence).
 */
export function triggerB_shouldFireOnAge(input: {
  pendingCount: number;
  oldestPendingAgeMs: number;
}): boolean {
  if (input.pendingCount === 0) return false;
  if (input.pendingCount >= MIN_BATCH_THRESHOLD) return true;
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
  // CIBA-HARDEN-05: clamp inputs to non-negative. A negative baseCeiling
  // would flip the ">=" comparisons in downstream callers and let every
  // fee rate through; a negative age would land in the base tier even
  // for a stale backlog. Neither should happen under current callers but
  // pinning the contract here is cheaper than trusting them.
  const baseCeiling = Math.max(0, input.baseCeiling);
  const oldestPendingAgeMs = Math.max(0, input.oldestPendingAgeMs);
  const THIRTY_MIN = 30 * 60 * 1000;
  const ONE_HOUR = 60 * 60 * 1000;
  let ceiling = baseCeiling;
  if (oldestPendingAgeMs > ONE_HOUR) ceiling = baseCeiling * 4;
  else if (oldestPendingAgeMs > THIRTY_MIN) ceiling = baseCeiling * 2;
  return Math.max(0, Math.min(ceiling, ABSOLUTE_FEE_CAP_SAT_PER_VB));
}

export interface BatchAnchorResult {
  processed: number;
  batchId: string | null;
  merkleRoot: string | null;
  txId: string | null;
  error?: string;
}

export interface BatchAnchorOptions {
  /** Limit claimed anchors to one organization. Used by org-admin queue runs. */
  orgId?: string | null;
  /** Bypass small/fresh queue deferral. Fee and treasury guards still apply. */
  force?: boolean;
  /** Diagnostic worker id stored on claimed anchors. */
  workerId?: string;
  /** Return a visible error instead of a quiet no-op when another batch is active. */
  failIfRunning?: boolean;
}

type ClaimPendingAnchorRow = {
  id: string;
  fingerprint: string;
  metadata: unknown;
  user_id?: string;
  org_id?: string;
  public_id?: string;
  credential_type?: string;
};

type ClaimPendingAnchorsRpc = (
  fn: 'claim_pending_anchors',
  params: Record<string, unknown>,
) => Promise<{ data: ClaimPendingAnchorRow[] | null; error: { message?: string } | null }>;

const EMPTY_BATCH_RESULT: BatchAnchorResult = { processed: 0, batchId: null, merkleRoot: null, txId: null };

/**
 * PostgREST row limit per response. Supabase caps RPC results at 1000 rows.
 * We claim in chunks of this size and accumulate up to BATCH_SIZE.
 */
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
export async function processBatchAnchors(
  options: BatchAnchorOptions = {},
): Promise<BatchAnchorResult> {
  // SCALE-3: Mutex — skip if already running
  if (batchProcessingRunning) {
    logger.info('Batch processing skipped — already in progress');
    if (options.failIfRunning) {
      return { ...EMPTY_BATCH_RESULT, error: 'Batch processing is already in progress' };
    }
    return EMPTY_BATCH_RESULT;
  }
  batchProcessingRunning = true;
  try {
    return await _processBatchAnchorsInner(options);
  } finally {
    batchProcessingRunning = false;
  }
}

async function treasuryHasFunds(chainClient: ReturnType<typeof getChainClient>): Promise<boolean> {
  try {
    if (!chainClient.hasFunds) return true;
    const funded = await chainClient.hasFunds();
    if (!funded) logger.warn('Treasury empty — skipping batch anchor processing until funded');
    return funded;
  } catch (err) {
    logger.warn({ error: err }, 'Pre-flight UTXO check failed — proceeding cautiously');
    return true;
  }
}

async function getPendingStats(orgId: string | null): Promise<{ pendingCount: number; oldestPendingAgeMs: number; hasPending: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let oldestQuery = (db as any)
    .from('anchors')
    .select('created_at')
    .eq('status', 'PENDING')
    .is('deleted_at', null);
  if (orgId) oldestQuery = oldestQuery.eq('org_id', orgId);
  const { data: stats } = await oldestQuery
    .order('created_at', { ascending: true })
    .limit(1)
    .single();

  if (!stats) return { pendingCount: 0, oldestPendingAgeMs: 0, hasPending: false };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let countQuery = (db as any)
    .from('anchors')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'PENDING')
    .is('deleted_at', null);
  if (orgId) countQuery = countQuery.eq('org_id', orgId);
  const { count } = await countQuery;

  return {
    pendingCount: count ?? 0,
    oldestPendingAgeMs: Date.now() - new Date(stats.created_at).getTime(),
    hasPending: true,
  };
}

async function shouldDeferForBatchRules(options: BatchAnchorOptions, orgId: string | null): Promise<{ defer: boolean; oldestPendingAgeMs: number }> {
  try {
    const stats = await getPendingStats(orgId);
    if (!stats.hasPending) {
      logger.debug('No pending anchors — skipping batch');
      return { defer: true, oldestPendingAgeMs: 0 };
    }
    if (!options.force && !triggerB_shouldFireOnAge(stats)) {
      logger.debug(
        { pendingCount: stats.pendingCount, oldestAgeMs: stats.oldestPendingAgeMs },
        `Deferring batch (pending=${stats.pendingCount}, oldestAgeMs=${stats.oldestPendingAgeMs})`,
      );
      return { defer: true, oldestPendingAgeMs: stats.oldestPendingAgeMs };
    }
    return { defer: false, oldestPendingAgeMs: stats.oldestPendingAgeMs };
  } catch (err) {
    logger.warn({ error: err }, 'Smart batch skip check failed — proceeding with batch');
    return { defer: false, oldestPendingAgeMs: 0 };
  }
}

async function feeCheckAllowsBatch(
  chainClient: ReturnType<typeof getChainClient>,
  oldestPendingAgeMs: number,
): Promise<boolean> {
  try {
    if (!chainClient.estimateCurrentFee) return true;
    const currentFee = await chainClient.estimateCurrentFee();
    const baseCeiling = config.maxFeeThresholdSatPerVbyte ?? 50;
    const effectiveCeiling = triggerC_computeFeeCeiling({ baseCeiling, oldestPendingAgeMs });

    if (currentFee > effectiveCeiling) {
      logger.warn(
        { currentFee, effectiveCeiling, baseCeiling, oldestPendingAgeMs },
        'Fee rate exceeds ceiling — deferring batch until fees drop',
      );
      return false;
    }

    logger.debug({ currentFee, effectiveCeiling }, 'Fee pre-check passed');
    return true;
  } catch (err) {
    logger.warn({ error: err }, 'Pre-claim fee check failed — proceeding cautiously');
    return true;
  }
}

type ClaimBatchResult =
  | { kind: 'claimed'; anchors: ClaimPendingAnchorRow[] }
  | { kind: 'empty' }
  | { kind: 'legacy' }
  | { kind: 'error'; message: string };

function buildClaimParams(options: BatchAnchorOptions, orgId: string | null, chunkSize: number): Record<string, unknown> {
  const claimParams: Record<string, unknown> = {
    p_worker_id: options.workerId ?? `batch-${process.pid}`,
    p_limit: chunkSize,
    p_exclude_pipeline: false,
  };
  if (orgId) claimParams.p_org_id = orgId;
  return claimParams;
}

function handleClaimError(
  claimError: { message?: string },
  allClaimed: ClaimPendingAnchorRow[],
  orgId: string | null,
): ClaimBatchResult | null {
  if (allClaimed.length > 0) {
    logger.warn({ error: claimError, claimedSoFar: allClaimed.length }, 'claim_pending_anchors chunk failed — proceeding with partial batch');
    return { kind: 'claimed', anchors: allClaimed };
  }
  if (orgId) {
    logger.error({ error: claimError, orgId }, 'claim_pending_anchors failed for org-scoped batch');
    return { kind: 'error', message: claimError.message ?? 'Failed to claim organization anchors' };
  }
  logger.warn({ error: claimError }, 'claim_pending_anchors RPC failed — falling back to legacy batch');
  return { kind: 'legacy' };
}

async function claimAnchorsForBatch(options: BatchAnchorOptions, orgId: string | null): Promise<ClaimBatchResult> {
  const allClaimed: ClaimPendingAnchorRow[] = [];
  let remaining = BATCH_SIZE;
  const claimPendingAnchors = db.rpc as unknown as ClaimPendingAnchorsRpc;

  while (remaining > 0) {
    const chunkSize = Math.min(remaining, POSTGREST_ROW_LIMIT);
    try {
      const { data: chunk, error } = await withDbTimeout(
        () => claimPendingAnchors('claim_pending_anchors', buildClaimParams(options, orgId, chunkSize)),
        30_000,
      );
      if (error) return handleClaimError(error, allClaimed, orgId) ?? { kind: 'empty' };
      if (!chunk || !Array.isArray(chunk) || chunk.length === 0) break;
      allClaimed.push(...chunk);
      remaining -= chunk.length;
      if (chunk.length < chunkSize) break;
    } catch (timeoutErr) {
      logger.error({ error: timeoutErr, claimedSoFar: allClaimed.length }, 'claim_pending_anchors timed out in batch');
      if (allClaimed.length === 0) return { kind: 'error', message: 'Timed out claiming pending anchors' };
      break;
    }
  }

  return allClaimed.length > 0 ? { kind: 'claimed', anchors: allClaimed } : { kind: 'empty' };
}

async function submitBatchMerkleRoot(merkleRoot: string, count: number): Promise<ChainReceipt | null> {
  try {
    const chainClient = getChainClient();
    const receipt = await chainClient.submitFingerprint({
      fingerprint: merkleRoot,
      timestamp: new Date().toISOString(),
    });
    if (receipt?.receiptId) return receipt;
    logger.error({ merkleRoot }, 'Batch chain broadcast returned empty receipt — bulk reverting claims');
    return null;
  } catch (error) {
    logger.error({ error, merkleRoot, count }, 'Batch anchor chain submission failed — bulk reverting claims');
    return null;
  }
}

async function submitClaimedAnchors(
  claimedAnchors: ClaimPendingAnchorRow[],
  receipt: ChainReceipt,
  merkleRoot: string,
  batchId: string,
): Promise<number | null> {
  const anchorIds = claimedAnchors.map((a) => a.id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: updatedCount, error: bulkError } = await (db.rpc as any)('submit_batch_anchors', {
    p_anchor_ids: anchorIds,
    p_tx_id: receipt.receiptId,
    p_block_height: receipt.blockHeight ?? null,
    p_block_timestamp: receipt.blockTimestamp ?? null,
    p_merkle_root: merkleRoot,
    p_batch_id: batchId,
  });

  if (bulkError) {
    logger.warn({ error: bulkError }, 'submit_batch_anchors RPC failed — bulk reverting claimed anchors to PENDING');
    await bulkRevertToPending(anchorIds);
    return null;
  }
  return typeof updatedCount === 'number' ? updatedCount : claimedAnchors.length;
}

async function persistBatchProofs(
  claimedAnchors: ClaimPendingAnchorRow[],
  receipt: ChainReceipt,
  merkleRoot: string,
  proofs: Map<string, unknown>,
  batchId: string,
): Promise<void> {
  try {
    await upsertAnchorProofs(
      db,
      claimedAnchors.map((anchor) => ({
        anchorId: anchor.id,
        receiptId: receipt.receiptId,
        blockHeight: receipt.blockHeight ?? null,
        blockTimestamp: receipt.blockTimestamp ?? null,
        merkleRoot,
        proofPath: proofs.get(anchor.fingerprint) ?? [],
        batchId,
      })),
    );
  } catch (proofError) {
    logger.warn({ error: proofError, batchId }, 'Failed to persist Merkle proofs for batch anchors');
  }
}

async function applyComplianceControls(claimedAnchors: ClaimPendingAnchorRow[]): Promise<void> {
  try {
    const byType = new Map<string | null, string[]>();
    for (const anchor of claimedAnchors) {
      const ct = anchor.credential_type ?? null;
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
}

async function _processBatchAnchorsInner(options: BatchAnchorOptions): Promise<BatchAnchorResult> {
  const orgId = options.orgId ?? null;

  // Phase 0a: Pre-flight UTXO check — skip immediately if treasury is empty.
  const chainClient = getChainClient();
  if (!(await treasuryHasFunds(chainClient))) return EMPTY_BATCH_RESULT;

  // Phase 0b: SCALE-1 — Smart batch skip + backlog age check
  const batchRules = await shouldDeferForBatchRules(options, orgId);
  if (batchRules.defer) return EMPTY_BATCH_RESULT;

  // Phase 0c: SCALE-2 — Pre-claim fee check with dynamic ceiling
  if (!(await feeCheckAllowsBatch(chainClient, batchRules.oldestPendingAgeMs))) return EMPTY_BATCH_RESULT;

  // Phase 1: Claim anchors in chunks (PostgREST caps RPC responses at 1000 rows)
  const claimResult = await claimAnchorsForBatch(options, orgId);
  if (claimResult.kind === 'legacy') return legacyProcessBatchAnchors();
  if (claimResult.kind === 'error') return { ...EMPTY_BATCH_RESULT, error: claimResult.message };
  if (claimResult.kind === 'empty') return EMPTY_BATCH_RESULT;
  const claimedAnchors = claimResult.anchors;

  if (claimedAnchors.length < MIN_BATCH_SIZE) {
    return EMPTY_BATCH_RESULT;
  }

  logger.info({ claimed: claimedAnchors.length, target: BATCH_SIZE, orgId }, 'Claimed anchors for batch processing');

  const fingerprints = claimedAnchors.map((a: { fingerprint: string }) => a.fingerprint);

  // Phase 2: Build Merkle tree
  const tree = buildMerkleTree(fingerprints);

  // Phase 3: Publish Merkle root to chain
  const receipt = await submitBatchMerkleRoot(tree.root, claimedAnchors.length);
  if (!receipt) {
    await bulkRevertToPending(claimedAnchors.map(a => a.id));
    return { ...EMPTY_BATCH_RESULT, merkleRoot: tree.root };
  }

  // Phase 4: Bulk update all claimed anchors BROADCASTING → SUBMITTED in one RPC call
  // (Individual PostgREST updates timeout under load — use DB-side bulk function)
  const batchId = `batch_${Date.now()}_${claimedAnchors.length}`;
  const processed = await submitClaimedAnchors(claimedAnchors, receipt, tree.root, batchId);
  if (processed === null) {
    return { processed: 0, batchId: null, merkleRoot: tree.root, txId: receipt.receiptId };
  }

  await persistBatchProofs(claimedAnchors, receipt, tree.root, tree.proofs, batchId);

  // CML-02: Populate compliance_controls per credential type (non-fatal post-processing)
  await applyComplianceControls(claimedAnchors);

  logger.info(
    {
      batchId,
      count: processed,
      total: claimedAnchors.length,
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
 * Bulk revert anchors from BROADCASTING to PENDING using batched IN queries.
 * Much faster than individual updates — prevents 504 timeouts on large batches.
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
async function legacyProcessBatchAnchors(): Promise<BatchAnchorResult> {
  const { data: pendingAnchors, error: fetchError } = await db
    .from('anchors')
    .select('id, fingerprint, metadata, credential_type')
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
    const chainClient = getChainClient();
    receipt = await chainClient.submitFingerprint({
      fingerprint: tree.root,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({ error, merkleRoot: tree.root }, 'Legacy batch chain submission failed');
    return { processed: 0, batchId: null, merkleRoot: tree.root, txId: null };
  }

  const batchId = `batch_${Date.now()}_${pendingAnchors.length}`;
  const anchorIds = pendingAnchors.map((a) => a.id);

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
    const proofRows: Array<{
      anchorId: string;
      receiptId: string;
      blockHeight: number | null;
      blockTimestamp: string | null;
      merkleRoot: string;
      proofPath: unknown;
      batchId: string;
    }> = [];

    for (const anchor of pendingAnchors) {
      const { error: updateError, count: updateCount } = await db
        .from('anchors')
        .update({
          status: 'SUBMITTED' as const,
          chain_tx_id: receipt.receiptId,
          chain_block_height: receipt.blockHeight,
          chain_timestamp: receipt.blockTimestamp,
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
      proofRows.push({
        anchorId: anchor.id,
        receiptId: receipt.receiptId,
        blockHeight: receipt.blockHeight ?? null,
        blockTimestamp: receipt.blockTimestamp ?? null,
        merkleRoot: tree.root,
        proofPath: tree.proofs.get(anchor.fingerprint) ?? [],
        batchId,
      });
    }

    try {
      await upsertAnchorProofs(db, proofRows);
    } catch (proofError) {
      logger.warn({ error: proofError, batchId }, 'Failed to persist Merkle proofs in legacy batch path');
    }

    logger.info({ batchId, count: updatedCount, total: pendingAnchors.length, merkleRoot: tree.root, txId: receipt.receiptId }, 'Legacy batch anchor processing complete (fallback)');
    return { processed: updatedCount, batchId, merkleRoot: tree.root, txId: receipt.receiptId };
  }

  const processed = typeof bulkCount === 'number' ? bulkCount : pendingAnchors.length;

  logger.info(
    { batchId, count: processed, total: pendingAnchors.length, merkleRoot: tree.root, txId: receipt.receiptId },
    'Legacy batch anchor processing complete',
  );

  return { processed, batchId, merkleRoot: tree.root, txId: receipt.receiptId };
}
