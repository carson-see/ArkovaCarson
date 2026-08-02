/**
 * Proof-branch availability — SCRUM-2575 / SCRUM-2576.
 *
 * The ONE answer to "can a per-document Merkle branch actually be served for
 * this anchor?", shared by the two API surfaces that must never disagree about
 * it: `GET /api/v1/verify/:publicId` (which advertises `proof_availability`) and
 * `GET /api/v1/verify/:publicId/proof` (which actually serves the branch).
 *
 * WHY THIS IS NOT IN `utils/merkle.ts`
 *
 * `merkle.ts` is vendored byte-for-byte into the clean-room verifier CLI
 * (`packages/verifier-cli/src/vendor/merkle.ts`, guarded by a byte-identity
 * test) because the recompute MUST stay shared and never re-implemented. That
 * vendored file is the verifier's trusted computing base and should contain the
 * cryptographic primitive and nothing else. Availability classification is
 * API-layer policy — an independent verifier has no use for it, and shipping it
 * across that boundary would widen the trusted base for no reason. It lives
 * here instead, importing only the shared entry type.
 */

import type { MerkleProofEntry } from './merkle.js';

/**
 * Validate that an untyped value is a well-formed Merkle branch.
 *
 * An EMPTY array is valid: a single-leaf tree's honest branch is `[]` (the root
 * IS the leaf), which is exactly what a single-leaf anchor stores post-FIX-1.
 * Emptiness means "no siblings to walk", not "no proof".
 */
export function isValidProofArray(arr: unknown): arr is MerkleProofEntry[] {
  if (!Array.isArray(arr)) return false;
  return arr.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as MerkleProofEntry).hash === 'string' &&
      ((entry as MerkleProofEntry).position === 'left' ||
        (entry as MerkleProofEntry).position === 'right'),
  );
}

/** The two places a Merkle branch can be stored for an anchor. */
export interface ProofBranchSources {
  /** `anchor_proofs.merkle_root` (preferred source). */
  storedRoot: unknown;
  /** `anchor_proofs.proof_path` (preferred source). */
  storedPath: unknown;
  /** `anchors.metadata` — the LEGACY proof location, still served by /proof. */
  metadata: Record<string, unknown> | null;
}

/**
 * SCRUM-2575 — can a per-document Merkle branch actually be SERVED for this
 * anchor?
 *
 * This is the single predicate behind the public `proof_availability` claim, and
 * it deliberately mirrors what `GET /verify/:publicId/proof` actually does:
 * prefer the stored `anchor_proofs` row, fall back to the legacy
 * `anchors.metadata` proof. Both arms require a root AND a well-formed branch,
 * because that is exactly the combination the proof route needs before it will
 * return 200.
 *
 * Getting this wrong in EITHER direction is a claims defect, not a cosmetic one:
 *   - too loose (e.g. accepting any non-empty array) ⇒ `/verify` advertises
 *     `per_document` while `/proof` answers 404 or 500 for the same record;
 *   - too strict (e.g. ignoring the legacy metadata arm) ⇒ `/verify` says
 *     `root_only` — "no self-contained per-document proof is available" — while
 *     `/proof` hands the caller exactly that proof.
 *
 * Fail-closed: anything unrecognised is "no branch". We only advertise a proof
 * we can see.
 */
export function hasServableProofBranch(sources: ProofBranchSources): boolean {
  const { storedRoot, storedPath, metadata } = sources;

  // Stored arm — mirrors extractStoredProof's guard.
  if (
    typeof storedRoot === 'string' &&
    storedRoot.length > 0 &&
    storedPath != null &&
    isValidProofArray(storedPath)
  ) {
    return true;
  }

  // Legacy metadata arm — mirrors extractMetadataProof's guard.
  const metaRoot = metadata?.merkle_root;
  const metaProof = metadata?.merkle_proof;
  return (
    typeof metaRoot === 'string' &&
    metaRoot.length > 0 &&
    metaProof != null &&
    isValidProofArray(metaProof)
  );
}
