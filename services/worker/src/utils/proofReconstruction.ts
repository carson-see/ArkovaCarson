/**
 * Chain-verified proof reconstruction (SCRUM-3187).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Arkova's headline promise is that a document can be verified OFFLINE,
 * forever, without trusting Arkova. That requires a per-document Merkle
 * inclusion branch for every SECURED anchor. ~2.97M historical anchors have no
 * such branch, because the batch producer of that era did not persist one.
 *
 * The leaf SET for a historical batch is recoverable — it is exactly the live
 * anchors sharing a `chain_tx_id`, and prod carries zero soft-deleted rows with
 * a `chain_tx_id`, so no batch has a hole in it. What was NOT persisted is the
 * leaf ORDER, and `buildMerkleTree` hashes leaves in the exact array order it
 * is given. A wrong order yields a wrong root.
 *
 * ── The invariant (§1.4, §1.5) ───────────────────────────────────────────────
 * This module NEVER returns a proof it has not verified against the root
 * actually committed on-chain. Concretely, before any success is returned:
 *
 *   1. the tree rebuilt from the candidate ordering must produce a root that is
 *      byte-equal to the OP_RETURN-committed root, and
 *   2. every emitted branch must independently re-verify against that same
 *      committed root via `verifyMerkleProof` — the exact check an offline
 *      verifier runs.
 *
 * If neither holds, the outcome is an honest failure. A proof that does not
 * verify is a false integrity claim, so returning NOTHING is always correct and
 * returning something plausible never is. There is deliberately no "best
 * effort" mode and no way to skip the check — the validation is inside the one
 * function that can construct rows, not a separate step a caller might forget.
 *
 * ── Why a search is legitimate here ──────────────────────────────────────────
 * Trying candidate leaf orderings is NOT guesswork, because the acceptance test
 * is the chain itself. An ordering either reproduces the committed root or it
 * does not; a false ordering cannot pass, since finding one would require a
 * second-preimage on double-SHA256. The search only ever recovers information
 * that the chain already pins down. Batch-of-1 is not exempt: its root must
 * still equal the committed root before an empty branch is emitted.
 */

import {
  buildMerkleTree,
  verifyMerkleProof,
  type MerkleProofEntry,
} from './merkle.js';

/** The on-chain commitment marker, hex-encoded — "ARKV". */
const ARKV_PREFIX_HEX = '41524b56';
/** A root is exactly 32 bytes. */
const ROOT_HEX_LEN = 64;
/** v0 payload allows an optional 8-byte metadata suffix after the root. */
const METADATA_HEX_LEN = 16;

/**
 * Leaf-count ceiling for the exhaustive ordering search. 8! = 40,320 candidate
 * trees is a sub-second, bounded cost; 9! and beyond is not worth a worker
 * slot, and the honest answer for those batches is "order unrecoverable".
 * Raising this trades CPU for coverage and changes NO safety property — every
 * candidate is still validated against the chain.
 */
export const MAX_PERMUTATION_SEARCH_LEAVES = 8;

export interface ReconstructionLeaf {
  /** anchors.id */
  id: string;
  /** anchors.fingerprint (64 hex chars) */
  fingerprint: string;
  /** anchors.created_at, ISO-8601 */
  createdAt: string;
  /**
   * Legacy `anchors.metadata.merkle_proof`, when present. UNTRUSTED INPUT: it
   * is a claim about an inclusion branch, not evidence of one. Prod contains
   * legacy branches that do NOT verify against the committed root (batch
   * 8f62259b…, 2026-03-26), so this is only ever used when it verifies. A
   * backfill that copied these into `anchor_proofs` unchecked would have
   * manufactured false integrity claims at scale.
   */
  storedBranch?: MerkleProofEntry[] | null;
}

/**
 * Recover a leaf's index from its branch. `entry.position` is the SIBLING's
 * side, so a sibling on the right means this node was the left child (bit 0).
 * Level i contributes bit i.
 */
export function merkleIndexFromBranch(branch: MerkleProofEntry[]): number {
  let index = 0;
  branch.forEach((entry, level) => {
    if (entry.position === 'left') index |= 1 << level;
  });
  return index;
}

export type ReconstructionFailureReason =
  | 'empty_leaf_set'
  | 'no_committed_root'
  | 'malformed_committed_root'
  | 'malformed_leaf'
  | 'leaf_order_unrecoverable';

export interface ReconstructedProofRow {
  anchor_id: string;
  /** Always the CHAIN-committed root. */
  merkle_root: string;
  proof_path: MerkleProofEntry[];
  merkle_index: number;
}

export type ReconstructionOutcome =
  | {
      ok: true;
      /** Which named strategy recovered the order — recorded for audit. */
      ordering: string;
      leafCount: number;
      rows: ReconstructedProofRow[];
    }
  | {
      ok: false;
      reason: ReconstructionFailureReason;
      leafCount: number;
      /** How many candidate orderings were tested before giving up. */
      orderingsTried: number;
    };

const HEX_RE = /^[0-9a-f]*$/;

function normaliseHex(input: string): string | null {
  const stripped = input.trim().toLowerCase().replace(/^0x/, '');
  if (stripped.length % 2 !== 0) return null;
  return HEX_RE.test(stripped) ? stripped : null;
}

/**
 * Extract the committed Merkle root from a raw OP_RETURN payload.
 *
 * Accepts the bare `ARKV ‖ root` commitment, the same with the optional 8-byte
 * metadata suffix, and the full scriptPubKey form (`6a` OP_RETURN plus its
 * pushdata length byte). Returns null for anything that is not an ARKV
 * commitment — the marker is REQUIRED, never inferred from length, so a
 * same-length non-Arkova payload can never be mistaken for a root.
 */
export function parseCommittedRoot(opReturnHex: string | null | undefined): string | null {
  if (!opReturnHex) return null;
  let hex = normaliseHex(opReturnHex);
  if (hex === null) return null;

  // Strip an OP_RETURN opcode and its immediate pushdata-length byte, if present.
  if (!hex.startsWith(ARKV_PREFIX_HEX) && hex.startsWith('6a')) {
    hex = hex.slice(2);
    const pushLen = Number.parseInt(hex.slice(0, 2), 16);
    // Direct pushdata opcodes are 0x01..0x4b.
    if (Number.isFinite(pushLen) && pushLen >= 0x01 && pushLen <= 0x4b) {
      hex = hex.slice(2);
    }
  }

  if (!hex.startsWith(ARKV_PREFIX_HEX)) return null;
  const payload = hex.slice(ARKV_PREFIX_HEX.length);
  if (payload.length !== ROOT_HEX_LEN && payload.length !== ROOT_HEX_LEN + METADATA_HEX_LEN) {
    return null;
  }
  return payload.slice(0, ROOT_HEX_LEN);
}

/**
 * Candidate leaf orderings, tried in this order. The list exists because prod
 * has had more than one batch producer: 2026-08 batches reconstruct under
 * `id_asc`, while 2026-03 batches match none of the natural sorts and are only
 * recovered by search. Adding a strategy is safe — the chain remains the judge.
 */
const ORDERING_STRATEGIES: ReadonlyArray<{
  name: string;
  apply: (leaves: ReconstructionLeaf[]) => ReconstructionLeaf[];
}> = [
  { name: 'id_asc', apply: (l) => [...l].sort((a, b) => a.id.localeCompare(b.id)) },
  {
    // The ordering documented by batch-anchor.ts sortAnchorsForBatch().
    name: 'fingerprint_asc_id_asc',
    apply: (l) =>
      [...l].sort((a, b) => {
        const fp = a.fingerprint.localeCompare(b.fingerprint);
        return fp !== 0 ? fp : a.id.localeCompare(b.id);
      }),
  },
  { name: 'created_asc_id_asc', apply: (l) => [...l].sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt))) },
  { name: 'created_desc_id_asc', apply: (l) => [...l].sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : b.createdAt.localeCompare(a.createdAt))) },
  { name: 'id_desc', apply: (l) => [...l].sort((a, b) => b.id.localeCompare(a.id)) },
  { name: 'fingerprint_desc', apply: (l) => [...l].sort((a, b) => b.fingerprint.localeCompare(a.fingerprint)) },
  { name: 'input_order', apply: (l) => [...l] },
  { name: 'input_reversed', apply: (l) => [...l].reverse() },
];

/**
 * Lazily enumerate permutations (Heap's algorithm) so a search can stop at the
 * first match without materialising n! arrays.
 */
function* permute<T>(items: T[]): Generator<T[]> {
  const arr = [...items];
  const c = new Array<number>(arr.length).fill(0);
  yield [...arr];
  let i = 0;
  while (i < arr.length) {
    if (c[i] < i) {
      const swap = i % 2 === 0 ? 0 : c[i];
      [arr[swap], arr[i]] = [arr[i], arr[swap]];
      yield [...arr];
      c[i] += 1;
      i = 0;
    } else {
      c[i] = 0;
      i += 1;
    }
  }
}

/**
 * Build rows for one candidate ordering, but ONLY if the rebuilt root is
 * byte-equal to the committed root AND every branch re-verifies against it.
 * This is the sole constructor of proof rows in this module, which is what
 * makes the "never emit an unverified proof" invariant structural rather than
 * a convention a caller has to remember.
 */
function materialiseIfValid(
  ordered: ReconstructionLeaf[],
  committedRoot: string,
): ReconstructedProofRow[] | null {
  const tree = buildMerkleTree(ordered.map((l) => l.fingerprint));
  if (tree.root !== committedRoot) return null;

  const rows: ReconstructedProofRow[] = ordered.map((l, index) => ({
    anchor_id: l.id,
    merkle_root: committedRoot,
    proof_path: tree.proofsByIndex[index] ?? [],
    merkle_index: index,
  }));

  // Independent re-verification: exactly what an offline verifier will do.
  for (let i = 0; i < rows.length; i += 1) {
    if (!verifyMerkleProof(ordered[i].fingerprint, rows[i].proof_path, committedRoot)) {
      return null;
    }
  }
  return rows;
}

/**
 * Reconstruct every per-document proof for one batch, or fail honestly.
 *
 * @param leaves        every live anchor sharing the batch's chain_tx_id
 * @param committedRoot the root committed on-chain (from the OP_RETURN), or
 *                      null when it could not be read — null is a REFUSAL, not
 *                      a licence to trust a locally computed root
 */
export function reconstructBatch(
  leaves: ReconstructionLeaf[],
  committedRoot: string | null | undefined,
  options: { maxPermutationLeaves?: number } = {},
): ReconstructionOutcome {
  const leafCount = leaves.length;
  if (leafCount === 0) {
    return { ok: false, reason: 'empty_leaf_set', leafCount, orderingsTried: 0 };
  }
  if (!committedRoot) {
    return { ok: false, reason: 'no_committed_root', leafCount, orderingsTried: 0 };
  }

  const root = normaliseHex(committedRoot);
  if (root === null || root.length !== ROOT_HEX_LEN) {
    return { ok: false, reason: 'malformed_committed_root', leafCount, orderingsTried: 0 };
  }
  for (const l of leaves) {
    const fp = normaliseHex(l.fingerprint);
    if (fp === null || fp.length !== ROOT_HEX_LEN) {
      return { ok: false, reason: 'malformed_leaf', leafCount, orderingsTried: 0 };
    }
  }

  let orderingsTried = 0;

  // Phase 0 — legacy stored branches. This is the ONLY path that can rescue a
  // batch too large for any ordering search, so it is tried first. Every leaf
  // must carry a branch AND every branch must verify against the committed
  // root; one bad branch rejects the whole batch, because a partially-true
  // batch is not something we can honestly serve.
  if (leaves.every((l) => Array.isArray(l.storedBranch) && l.storedBranch.length > 0)) {
    const allVerify = leaves.every((l) =>
      verifyMerkleProof(l.fingerprint, l.storedBranch as MerkleProofEntry[], root),
    );
    if (allVerify) {
      return {
        ok: true,
        ordering: 'stored_branch',
        leafCount,
        rows: leaves.map((l) => {
          const branch = l.storedBranch as MerkleProofEntry[];
          return {
            anchor_id: l.id,
            merkle_root: root,
            proof_path: branch,
            merkle_index: merkleIndexFromBranch(branch),
          };
        }),
      };
    }
  }

  // Phase 1 — deterministic strategies (cheap, and they cover the modern
  // producer). A single-leaf batch is settled here: buildMerkleTree returns
  // root === fingerprint, so it passes only if the chain agrees.
  for (const strategy of ORDERING_STRATEGIES) {
    orderingsTried += 1;
    const rows = materialiseIfValid(strategy.apply(leaves), root);
    if (rows) {
      return { ok: true, ordering: strategy.name, leafCount, rows };
    }
  }

  // Phase 2 — bounded exhaustive search for small batches whose producer left
  // no recoverable order. Still chain-judged: a wrong order cannot pass.
  // Hard cap the override: the search is factorial, so an unclamped caller
  // value is a denial-of-service switch (11! ≈ 40M trees). The override may
  // only ever LOWER the budget.
  const requested = options.maxPermutationLeaves ?? MAX_PERMUTATION_SEARCH_LEAVES;
  const budget = Math.max(1, Math.min(requested, MAX_PERMUTATION_SEARCH_LEAVES));
  if (leafCount <= budget) {
    for (const candidate of permute(leaves)) {
      orderingsTried += 1;
      const rows = materialiseIfValid(candidate, root);
      if (rows) {
        return { ok: true, ordering: 'exhaustive_search', leafCount, rows };
      }
    }
  }

  return { ok: false, reason: 'leaf_order_unrecoverable', leafCount, orderingsTried };
}
