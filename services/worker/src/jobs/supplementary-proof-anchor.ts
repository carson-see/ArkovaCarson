/**
 * SCRUM-3188 — SUPPLEMENTARY PROOF ANCHOR JOB.
 *
 * Re-commits the fingerprints of SECURED anchors that can never be given an
 * offline branch against their ORIGINAL transaction (the leaf order was never
 * persisted; see utils/supplementaryProof.ts for the full history) into NEW
 * Bitcoin transactions whose leaf order IS recorded, then writes chain-verified
 * per-document proofs.
 *
 * ── The four things this job must never do ─────────────────────────────────
 *
 * 1. NEVER touch the original attestation. `anchors.chain_tx_id`,
 *    `chain_timestamp`, `chain_block_height` and `chain_block_hash` stay exactly
 *    as they are. This is structural, not disciplinary: the job's ports contain
 *    no capability to write to `anchors` at all, and the one DB function it
 *    calls (`insert_supplementary_proofs`) only INSERTs into `anchor_proofs`.
 *    A supplementary transaction is additional evidence, never a re-attestation.
 *
 * 2. NEVER broadcast twice for one cohort. The signed txid + exact cohort +
 *    recorded leaf order are journaled to `supplementary_anchor_journal` BEFORE
 *    any bytes reach the network, and that table's partial unique indexes make a
 *    live txid or batch unrepeatable. A crash between sign and broadcast is
 *    resolved by exact-txid replay detection, never by signing new bytes. An
 *    ambiguous broadcast outcome HOLDs and stops the run — it never REVERTs,
 *    because "we do not know" is not "it did not happen".
 *
 * 3. NEVER write a proof it has not verified. The committed root is read back
 *    from the transaction's OP_RETURN on-chain and every emitted branch must
 *    re-verify against THAT root before a single row is written
 *    (`buildVerifiedSupplementaryProofRows`). No best-effort mode.
 *
 * 4. NEVER drain the treasury. A fee ceiling and a treasury reserve are
 *    re-evaluated before every batch, because production anchoring spends from
 *    the same wallet.
 *
 * Modelled in machines/bitcoinAnchor.machine.ts as `supplementaryProof`
 * (NONE -> JOURNALED -> ANCHORED) with the checked invariant
 * `supplementaryRequiresOriginalAttestation`.
 *
 * DRY RUN IS THE DEFAULT. A caller that forgets to say anything gets a report,
 * not a transaction.
 */

import {
  planSupplementaryBatch,
  buildVerifiedSupplementaryProofRows,
  assessSupplementarySpend,
  estimateSupplementaryRun,
  UnverifiedSupplementaryProofError,
  type SupplementaryRunEstimate,
} from '../utils/supplementaryProof.js';

export interface SupplementaryCohortRow {
  anchorId: string;
  fingerprint: string;
  /** The anchor's EXISTING attestation. Read-only. */
  chainTxId: string;
  orgId?: string | null;
}

export interface PreparedSupplementaryTx {
  txId: string;
  txHex: string;
  feeSats: number;
  opReturnData: string;
}

export interface SupplementaryBroadcastReceipt {
  receiptId: string;
  blockHeight?: number | null;
  blockTimestamp?: string | null;
  confirmations?: number;
}

export type SupplementaryJournalOutcome = 'CREATED' | 'EXACT_REPLAY' | 'CONFLICT';

/**
 * Every external effect the job can have, named explicitly.
 *
 * There is deliberately NO port that can write to `anchors`. That absence is
 * the enforcement of the integrity constraint, and it is asserted by a test.
 */
export interface SupplementaryPorts {
  countRemaining(): Promise<number>;
  claimCohort(
    limit: number,
    priorityOrgIds?: string[],
    deprioritizedCredentialTypes?: string[],
  ): Promise<SupplementaryCohortRow[]>;
  getFeeRate(): Promise<number>;
  getConfirmedBalanceSats(): Promise<number>;
  prepareTx(root: string): Promise<PreparedSupplementaryTx>;
  broadcast(txHex: string): Promise<SupplementaryBroadcastReceipt>;
  /** Read the root the tx's OP_RETURN actually commits, from the CHAIN. */
  readCommittedRoot(txid: string): Promise<string | null>;
  persistJournal(args: {
    batchId: string;
    txid: string;
    fingerprintRoot: string;
    anchorIds: string[];
    leafOrder: Array<{ anchor_id: string; fingerprint: string }>;
  }): Promise<{
    journalId: string;
    outcome: SupplementaryJournalOutcome;
    conflictReason?: string;
  }>;
  resolveJournal(
    journalId: string,
    action: 'ADOPT' | 'REVERT' | 'HOLD' | 'PERSIST',
    reason?: string,
  ): Promise<boolean>;
  insertProofs(rows: Record<string, unknown>[]): Promise<number>;
  sleep(ms: number): Promise<void>;
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}

export interface SupplementaryRunOptions {
  /** DEFAULT TRUE. Nothing is signed or broadcast unless explicitly false. */
  dryRun?: boolean;
  batchSize?: number;
  maxBatches?: number;
  feeCeilingSatVb?: number;
  treasuryReserveSats?: number;
  pauseBetweenBatchesMs?: number;
  priorityOrgIds?: string[];
  deprioritizedCredentialTypes?: string[];
}

export interface SupplementaryRunResult {
  dryRun: boolean;
  batchesCompleted: number;
  anchorsProven: number;
  satsSpent: number;
  remaining: number;
  estimate: SupplementaryRunEstimate;
  /** Dry run only: the root the first batch WOULD commit. */
  previewRoot?: string;
  stoppedReason: string;
}

export const DEFAULT_SUPPLEMENTARY_BATCH_SIZE = 20_000;
/**
 * Deliberately NOT wired to `config.batchAnchorMaxSize`. That value is a Zod
 * `.max(10000)` boot gate on the PRODUCTION anchoring path; this constant is
 * this job's own ceiling, so changing it cannot affect the live producer.
 *
 * 20,000 (CTO, 2026-08-11). Cost is per-TRANSACTION — the Merkle root is 32
 * bytes in OP_RETURN regardless of leaf count, and the measured tx is 156.25 vB
 * (1-in/2-out, from real prod tx c86c3927). So halving the transaction count
 * halves the spend: 2,969,630 anchors is 297 txs at 10k (139,293 sats @3 sat/vB)
 * versus 149 txs at 20k (69,881 sats) — about $76 saved for a one-line change to
 * an isolated constant.
 *
 * Going further to 50k would save only a further ~$46 and WOULD require widening
 * the production Zod gate, whose failure mode is the worker refusing to boot.
 * That trade is not worth it and is filed as backlog rather than taken here.
 *
 * A larger batch is not free of risk: one failed run leaves more anchors
 * unproven for longer. That is bounded by the journal (a batch is replayable and
 * cannot double-broadcast) and by `maxBatches`, so run `maxBatches: 1` first and
 * verify the emitted proofs against the on-chain root before opening the tap.
 */
export const DEFAULT_FEE_CEILING_SAT_VB = 5;
export const DEFAULT_TREASURY_RESERVE_SATS = 100_000;
export const DEFAULT_PAUSE_MS = 2_000;

function noopLog() { /* silent by default in tests */ }

export async function runSupplementaryProofAnchor(
  options: SupplementaryRunOptions,
  ports: SupplementaryPorts,
): Promise<SupplementaryRunResult> {
  // Dry run unless the caller explicitly opts out.
  const dryRun = options.dryRun !== false;
  const batchSize = Math.min(
    Math.max(options.batchSize ?? DEFAULT_SUPPLEMENTARY_BATCH_SIZE, 1),
    DEFAULT_SUPPLEMENTARY_BATCH_SIZE,
  );
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
  const feeCeilingSatVb = options.feeCeilingSatVb ?? DEFAULT_FEE_CEILING_SAT_VB;
  const treasuryReserveSats = options.treasuryReserveSats ?? DEFAULT_TREASURY_RESERVE_SATS;
  const pauseMs = options.pauseBetweenBatchesMs ?? DEFAULT_PAUSE_MS;
  const log = ports.log ?? noopLog;

  const remaining = await ports.countRemaining();
  const feeRate = await ports.getFeeRate();
  const estimate = estimateSupplementaryRun({
    anchorCount: remaining,
    batchSize,
    feeRateSatVb: feeRate,
  });

  let batchesCompleted = 0;
  let anchorsProven = 0;
  let satsSpent = 0;
  let previewRoot: string | undefined;
  let stoppedReason = 'backlog exhausted — run complete';

  while (batchesCompleted < maxBatches) {
    const cohort = await ports.claimCohort(
      batchSize,
      options.priorityOrgIds,
      options.deprioritizedCredentialTypes,
    );
    if (cohort.length === 0) {
      stoppedReason = 'backlog exhausted — run complete';
      break;
    }

    // Order the cohort and build the tree. The order we are about to journal is
    // the order that produces this root — that is the whole point.
    const plan = planSupplementaryBatch(
      cohort.map((c) => ({ anchorId: c.anchorId, fingerprint: c.fingerprint })),
    );

    if (dryRun) {
      previewRoot = plan.root;
      stoppedReason = 'dry run — nothing signed, nothing broadcast, nothing written';
      break;
    }

    // ── Spend guards, re-evaluated EVERY batch (fees move) ──
    const currentFeeRate = batchesCompleted === 0 ? feeRate : await ports.getFeeRate();
    const balance = await ports.getConfirmedBalanceSats();
    const spend = assessSupplementarySpend({
      confirmedBalanceSats: balance,
      feeRateSatVb: currentFeeRate,
      remainingBatches: 1,
      feeCeilingSatVb,
      treasuryReserveSats,
    });
    if (!spend.affordable) {
      stoppedReason = `spend guard: ${spend.reason}`;
      log('warn', 'Supplementary run halted by spend guard', { reason: spend.reason });
      break;
    }

    // ── Sign (no network) ──
    const prepared = await ports.prepareTx(plan.root);

    // ── Journal BEFORE broadcast. This is the anti-double-broadcast barrier. ──
    const journal = await ports.persistJournal({
      batchId: `supp_${Date.now()}_${plan.leafOrder.length}`,
      txid: prepared.txId,
      fingerprintRoot: plan.root,
      anchorIds: plan.leafOrder.map((l) => l.anchorId),
      leafOrder: plan.leafOrder.map((l) => ({
        anchor_id: l.anchorId,
        fingerprint: l.fingerprint,
      })),
    });

    if (journal.outcome === 'EXACT_REPLAY') {
      // These exact signed bytes are already journaled — a previous attempt may
      // be live on the network. Broadcasting again is how you pay twice.
      stoppedReason = 'journal reports an existing live attempt for this cohort — deferring without broadcast';
      log('warn', stoppedReason, { txId: prepared.txId });
      break;
    }
    if (journal.outcome === 'CONFLICT') {
      stoppedReason = `journal conflict: ${journal.conflictReason ?? 'unknown'} — not broadcasting`;
      log('error', stoppedReason, { txId: prepared.txId });
      break;
    }

    // ── Broadcast ──
    let receipt: SupplementaryBroadcastReceipt;
    try {
      receipt = await ports.broadcast(prepared.txHex);
    } catch (error) {
      // Unknown outcome: the transaction MAY be live. HOLD and stop. Never
      // REVERT on ambiguity, and never continue stacking unresolved journals.
      await ports.resolveJournal(journal.journalId, 'HOLD', 'broadcast_outcome_unknown');
      stoppedReason = `broadcast outcome unknown (ambiguous) — journal HELD, run stopped: ${
        error instanceof Error ? error.message : String(error)
      }`;
      log('error', stoppedReason, { txId: prepared.txId });
      break;
    }

    const broadcastTxId = (receipt.receiptId || prepared.txId).toLowerCase();
    if (broadcastTxId !== prepared.txId.toLowerCase()) {
      await ports.resolveJournal(journal.journalId, 'HOLD', 'broadcast_txid_mismatch');
      stoppedReason = 'provider returned a different txid than the signed bytes — journal HELD';
      log('error', stoppedReason, { expected: prepared.txId, got: broadcastTxId });
      break;
    }
    satsSpent += prepared.feeSats;

    // ── The chain is the judge: read the committed root back from OP_RETURN ──
    const committedRoot = await ports.readCommittedRoot(broadcastTxId);
    if (!committedRoot) {
      await ports.resolveJournal(journal.journalId, 'HOLD', 'committed_root_unreadable');
      stoppedReason = 'could not read the committed root back from the chain — journal HELD, no proofs written';
      log('error', stoppedReason, { txId: broadcastTxId });
      break;
    }

    // ── Construct proofs ONLY if every branch verifies against that root ──
    let rows;
    try {
      rows = buildVerifiedSupplementaryProofRows({
        plan,
        committedRoot,
        supplementaryTxId: broadcastTxId,
        originalTxIdByAnchorId: new Map(cohort.map((c) => [c.anchorId, c.chainTxId])),
        batchId: journal.journalId,
        blockHeight: receipt.blockHeight ?? null,
        blockTimestamp: receipt.blockTimestamp ?? null,
      });
    } catch (error) {
      const unverified = error instanceof UnverifiedSupplementaryProofError;
      await ports.resolveJournal(
        journal.journalId,
        'HOLD',
        unverified ? 'proof_verification_failed' : 'proof_construction_failed',
      );
      stoppedReason = `refused to write unverified proofs — journal HELD: ${
        error instanceof Error ? error.message : String(error)
      }`;
      log('error', stoppedReason, { txId: broadcastTxId });
      break;
    }

    const inserted = await ports.insertProofs(
      rows.map((r) => ({
        anchor_id: r.anchorId,
        receipt_id: r.receiptId,
        merkle_root: r.merkleRoot,
        proof_path: r.proofPath,
        merkle_index: r.merkleIndex,
        batch_id: r.batchId,
        block_height: r.blockHeight,
        block_timestamp: r.blockTimestamp,
        is_supplementary: r.isSupplementary,
        supplements_chain_tx_id: r.supplementsChainTxId,
        proof_completeness_class: r.proofCompletenessClass,
      })),
    );

    await ports.resolveJournal(journal.journalId, 'ADOPT', 'supplementary_proofs_written');

    anchorsProven += inserted;
    batchesCompleted += 1;
    log('info', 'Supplementary batch anchored and proven', {
      txId: broadcastTxId,
      leaves: rows.length,
      inserted,
    });

    if (batchesCompleted < maxBatches && pauseMs > 0) {
      await ports.sleep(pauseMs);
    }
  }

  if (batchesCompleted >= maxBatches && Number.isFinite(maxBatches)) {
    stoppedReason = `reached maxBatches (${maxBatches})`;
  }

  return {
    dryRun,
    batchesCompleted,
    anchorsProven,
    satsSpent,
    remaining,
    estimate,
    previewRoot,
    stoppedReason,
  };
}
