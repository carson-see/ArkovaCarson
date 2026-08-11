/**
 * SCRUM-3188 — SUPPLEMENTARY PROOF ANCHOR (pure core).
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * 2,969,630 SECURED anchors hold a REAL first attestation on Bitcoin but no
 * per-document Merkle branch. The Mar/Apr producer fed `claim_pending_anchors`
 * rows straight into `buildMerkleTree`; `UPDATE … RETURNING` carries no ordering
 * guarantee, so the committed leaf ORDER was a query-plan artifact and was never
 * persisted. The leaf SET is intact, but for batches larger than 8 leaves the
 * order is unrecoverable — those records can never be given an offline branch
 * against their ORIGINAL transaction. (PR #2130 recovers the 608 records where
 * the order IS searchable; this module is the complementary path for the rest.)
 *
 * ── What this does, and what it must never do ──────────────────────────────
 * The remedy is a SECOND Bitcoin transaction re-committing the same fingerprints
 * in a RECORDED, deterministic order, producing verifiable per-document proofs.
 *
 * It is ADDITIVE. The original attestation — `anchors.chain_tx_id`,
 * `chain_timestamp`, `chain_block_height`, `chain_block_hash` — is READ-ONLY to
 * this entire subsystem. Overwriting it would backdate-shift a genuine 2026-06
 * commitment to today and destroy the exact evidence the product sells; that is
 * a worse defect than the missing proof. Formalised as the TLA invariant
 * `supplementaryRequiresOriginalAttestation` in
 * `machines/bitcoinAnchor.machine.ts`, and enforced here by requiring every row
 * to name the attestation it supplements.
 *
 * ── The hard invariant ─────────────────────────────────────────────────────
 * `buildVerifiedSupplementaryProofRows` is the ONLY way to construct a proof
 * row, and it does so only after (1) the planned root is byte-equal to the root
 * the CHAIN committed, and (2) EVERY emitted branch independently re-verifies
 * via `verifyMerkleProof` against that same root — the exact check an offline
 * verifier runs. There is no best-effort mode and no flag to skip it, matching
 * the invariant PR #2130 established for reconstruction.
 */

import {
  buildMerkleTree,
  verifyMerkleProof,
  type MerkleProofEntry,
} from './merkle.js';

/**
 * Measured vsize of a real production anchoring transaction
 * (`c86c3927c0791fe08aaedcb3192d4926d5a9999212516f6535d0f35828ba6a59`,
 * block 961,982): 1 P2WPKH input, OP_RETURN "ARKV"+32-byte root, P2WPKH change.
 * A supplementary tx has the identical shape — one root commits an unlimited
 * number of leaves, so cost is per-TRANSACTION, not per-document.
 */
export const SUPPLEMENTARY_TX_VSIZE = 156.25;

/** The class recorded on every row this subsystem writes. */
export const SUPPLEMENTARY_PROOF_CLASS = 'supplementary_anchored' as const;

const HEX64 = /^[0-9a-f]{64}$/;

/** Thrown when a proof could not be proven against the chain-committed root. */
export class UnverifiedSupplementaryProofError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnverifiedSupplementaryProofError';
  }
}

export interface SupplementaryLeaf {
  anchorId: string;
  fingerprint: string;
}

export interface SupplementaryBatchPlan {
  /** The RECORDED order. Persisted verbatim before broadcast. */
  leafOrder: SupplementaryLeaf[];
  root: string;
  proofsByIndex: MerkleProofEntry[][];
}

export interface SupplementaryProofRow {
  anchorId: string;
  fingerprint: string;
  /** The NEW supplementary transaction. Never the original attestation. */
  receiptId: string;
  merkleRoot: string;
  proofPath: MerkleProofEntry[];
  merkleIndex: number;
  batchId: string;
  blockHeight: number | null;
  blockTimestamp: string | null;
  isSupplementary: true;
  /** The ORIGINAL attestation this supplements. Mandatory, never null. */
  supplementsChainTxId: string;
  proofCompletenessClass: typeof SUPPLEMENTARY_PROOF_CLASS;
}

function normaliseFingerprint(value: string, anchorId: string): string {
  if (typeof value !== 'string' || !HEX64.test(value.toLowerCase())) {
    throw new Error(
      `Invalid fingerprint for anchor ${anchorId}: expected 64 hex characters`,
    );
  }
  return value.toLowerCase();
}

/**
 * Deterministic supplementary leaf ordering: (fingerprint asc, anchorId asc).
 *
 * Deliberately identical to `sortAnchorsForBatch` in `jobs/batch-anchor.ts`, so
 * the supplementary tree is built by the same rule as the live producer's. The
 * committed root becomes a pure function of the leaf SET — reproducible across
 * crash, retry, and re-run — which is precisely the property the Mar/Apr
 * producer lacked.
 */
export function orderSupplementaryLeaves(
  leaves: SupplementaryLeaf[],
): SupplementaryLeaf[] {
  const seen = new Set<string>();
  const normalised = leaves.map((leaf) => {
    if (seen.has(leaf.anchorId)) {
      throw new Error(`Cohort contains duplicate anchor id ${leaf.anchorId}`);
    }
    seen.add(leaf.anchorId);
    return {
      anchorId: leaf.anchorId,
      fingerprint: normaliseFingerprint(leaf.fingerprint, leaf.anchorId),
    };
  });

  return normalised.sort((a, b) => {
    const fp = a.fingerprint.localeCompare(b.fingerprint);
    if (fp !== 0) return fp;
    return a.anchorId.localeCompare(b.anchorId);
  });
}

/** Order the cohort, build its tree, and keep the order that produced it. */
export function planSupplementaryBatch(
  leaves: SupplementaryLeaf[],
): SupplementaryBatchPlan {
  if (leaves.length === 0) {
    throw new Error('Cannot plan a supplementary batch from an empty cohort');
  }
  const leafOrder = orderSupplementaryLeaves(leaves);
  const tree = buildMerkleTree(leafOrder.map((l) => l.fingerprint));
  return { leafOrder, root: tree.root, proofsByIndex: tree.proofsByIndex };
}

/**
 * THE hard invariant. Construct proof rows only if the chain agrees.
 *
 * `committedRoot` MUST be read from the confirmed supplementary transaction's
 * OP_RETURN — not from our own database. Passing our own planned root back in
 * would make this check circular and worthless.
 */
export function buildVerifiedSupplementaryProofRows(args: {
  plan: SupplementaryBatchPlan;
  /** Root read from the supplementary tx's OP_RETURN on-chain. */
  committedRoot: string;
  supplementaryTxId: string;
  /** anchorId -> the anchor's existing, untouched chain_tx_id. */
  originalTxIdByAnchorId: Map<string, string>;
  batchId: string;
  blockHeight?: number | null;
  blockTimestamp?: string | null;
}): SupplementaryProofRow[] {
  const {
    plan,
    committedRoot,
    supplementaryTxId,
    originalTxIdByAnchorId,
    batchId,
  } = args;

  const txId = String(supplementaryTxId ?? '').toLowerCase();
  if (!HEX64.test(txId)) {
    throw new UnverifiedSupplementaryProofError(
      'Supplementary txid must be 64 hex characters',
    );
  }

  const chainRoot = String(committedRoot ?? '').toLowerCase();
  if (!HEX64.test(chainRoot)) {
    throw new UnverifiedSupplementaryProofError(
      'Chain-committed root must be 64 hex characters',
    );
  }

  // (1) The tree we built must be the tree the chain committed.
  if (chainRoot !== plan.root.toLowerCase()) {
    throw new UnverifiedSupplementaryProofError(
      `Planned root ${plan.root} does not match the chain-committed root ${chainRoot} — refusing to write proofs`,
    );
  }

  if (plan.proofsByIndex.length !== plan.leafOrder.length) {
    throw new UnverifiedSupplementaryProofError(
      'Branch count does not match the recorded leaf order',
    );
  }

  return plan.leafOrder.map((leaf, index) => {
    const proofPath = plan.proofsByIndex[index] ?? [];

    // (2) Every branch must independently re-verify against that same root —
    // the exact computation an offline verifier performs. A batch of 1 is NOT
    // exempt: it is where fabrication would be easiest.
    if (!verifyMerkleProof(leaf.fingerprint, proofPath, chainRoot)) {
      throw new UnverifiedSupplementaryProofError(
        `Branch for anchor ${leaf.anchorId} (index ${index}) does not verify against the chain-committed root — refusing to write proofs`,
      );
    }

    const originalTxId = originalTxIdByAnchorId.get(leaf.anchorId);
    if (!originalTxId) {
      // Without this, the supplementary tx could later be read as the record's
      // FIRST attestation. Refuse rather than emit an ambiguous row.
      throw new Error(
        `Anchor ${leaf.anchorId} has no known original attestation — refusing to write a supplementary proof that cannot name what it supplements`,
      );
    }
    if (originalTxId.toLowerCase() === txId) {
      throw new Error(
        `Supplementary txid must differ from the original attestation for anchor ${leaf.anchorId}`,
      );
    }

    return {
      anchorId: leaf.anchorId,
      fingerprint: leaf.fingerprint,
      receiptId: txId,
      merkleRoot: chainRoot,
      proofPath,
      merkleIndex: index,
      batchId,
      blockHeight: args.blockHeight ?? null,
      blockTimestamp: args.blockTimestamp ?? null,
      isSupplementary: true,
      supplementsChainTxId: originalTxId.toLowerCase(),
      proofCompletenessClass: SUPPLEMENTARY_PROOF_CLASS,
    };
  });
}

export interface SupplementarySpendAssessment {
  affordable: boolean;
  satsPerTx: number;
  estimatedTotalSats: number;
  spendableSats: number;
  affordableBatches: number;
  reason?: string;
}

/**
 * Bound the spend two ways before anything is signed:
 *  - a FEE CEILING, so a fee spike cannot silently multiply the run's cost;
 *  - a TREASURY RESERVE, so a supplementary run can never starve production
 *    anchoring, which spends from the same wallet.
 */
export function assessSupplementarySpend(args: {
  confirmedBalanceSats: number;
  feeRateSatVb: number;
  remainingBatches: number;
  feeCeilingSatVb: number;
  treasuryReserveSats: number;
}): SupplementarySpendAssessment {
  const {
    confirmedBalanceSats,
    feeRateSatVb,
    remainingBatches,
    feeCeilingSatVb,
    treasuryReserveSats,
  } = args;

  for (const [name, value] of Object.entries(args)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`assessSupplementarySpend: ${name} must be a non-negative finite number`);
    }
  }

  const satsPerTx = Math.ceil(SUPPLEMENTARY_TX_VSIZE * feeRateSatVb);
  const estimatedTotalSats = satsPerTx * remainingBatches;
  const spendableSats = Math.max(0, confirmedBalanceSats - treasuryReserveSats);
  const affordableBatches = satsPerTx > 0 ? Math.floor(spendableSats / satsPerTx) : 0;

  if (feeRateSatVb > feeCeilingSatVb) {
    return {
      affordable: false,
      satsPerTx,
      estimatedTotalSats,
      spendableSats,
      affordableBatches,
      reason: `fee rate ${feeRateSatVb} sat/vB exceeds the configured ceiling of ${feeCeilingSatVb} sat/vB`,
    };
  }

  if (estimatedTotalSats > spendableSats) {
    return {
      affordable: false,
      satsPerTx,
      estimatedTotalSats,
      spendableSats,
      affordableBatches,
      reason: `completing this run needs ${estimatedTotalSats} sats but only ${spendableSats} are spendable above the ${treasuryReserveSats}-sat treasury reserve`,
    };
  }

  return {
    affordable: true,
    satsPerTx,
    estimatedTotalSats,
    spendableSats,
    affordableBatches,
  };
}

export interface SupplementaryRunEstimate {
  anchorCount: number;
  batchSize: number;
  transactions: number;
  feeRateSatVb: number;
  satsPerTx: number;
  totalSats: number;
  totalBtc: number;
}

/** The dry-run number: exactly what a full run would broadcast and spend. */
export function estimateSupplementaryRun(args: {
  anchorCount: number;
  batchSize: number;
  feeRateSatVb: number;
}): SupplementaryRunEstimate {
  const { anchorCount, batchSize, feeRateSatVb } = args;
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    throw new Error('estimateSupplementaryRun: batchSize must be positive');
  }
  const transactions = Math.ceil(anchorCount / batchSize);
  const satsPerTx = Math.ceil(SUPPLEMENTARY_TX_VSIZE * feeRateSatVb);
  const totalSats = satsPerTx * transactions;
  return {
    anchorCount,
    batchSize,
    transactions,
    feeRateSatVb,
    satsPerTx,
    totalSats,
    totalBtc: totalSats / 1e8,
  };
}
