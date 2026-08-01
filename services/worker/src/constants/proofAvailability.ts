/**
 * Proof availability — SCRUM-2575 / SCRUM-2576 (PROOF-BACKCATALOG, parent
 * SCRUM-2491).
 *
 * WHY THIS EXISTS
 *
 * Prod holds ~2.97M SECURED anchors. Only a small fraction (~6,110 at the last
 * census) carry a STORED per-document inclusion proof; the rest are
 * direct-anchored — one transaction per anchor, the OP_RETURN commits the
 * fingerprint itself, and there is no Merkle branch to store. That is a
 * perfectly sound way to anchor a record, but it is NOT the same capability as
 * "download a self-contained proof and verify this document offline."
 *
 * Until now `GET /api/v1/verify/:publicId` said nothing about the difference. A
 * consumer reading `verified: true` alongside a `merkle_proof_hash` had no way
 * to know whether a per-document proof could actually be retrieved; it had to
 * call `/proof` and interpret a 404. Constitution §1.5 requires a proof surface
 * to state what is measured, what is asserted, and what is NOT asserted, and the
 * R-7 claims gate forbids implying a capability we do not have for a given
 * record.
 *
 * WHAT IS MEASURED
 *
 * The classification is derived from stored data only — whether an
 * `anchor_proofs` row carries a non-empty inclusion branch. It is never guessed,
 * never inferred from `anchors.status`, and never backfilled by assumption. This
 * module states availability; it does NOT materialize proofs (that is the
 * separate proof-materializer / branch-backfill work, deliberately out of scope
 * here).
 */

/**
 * Whether a per-document proof can be retrieved for this record.
 *
 * - `per_document` — a per-document inclusion branch is stored; `/proof` returns
 *   it, and an independent verifier can check this specific document against the
 *   committed root.
 * - `root_only` — no per-document branch is stored. The record's fingerprint is
 *   committed on-chain via the referenced anchor receipt (directly, or under a
 *   batch root), but Arkova cannot hand out a self-contained per-document proof
 *   bundle for it.
 *
 * Deliberately NOT an enum of the internal classifier's vocabulary
 * (`already_complete` / `direct_anchored` / `batch_provable` / `ambiguous`, see
 * `jobs/proof-backcatalog-classifier.ts`). Those describe an operational census;
 * this describes the one thing a caller can act on — can I get a proof or not.
 */
export const PROOF_AVAILABILITY = {
  PER_DOCUMENT: 'per_document',
  ROOT_ONLY: 'root_only',
} as const;

export type ProofAvailability =
  (typeof PROOF_AVAILABILITY)[keyof typeof PROOF_AVAILABILITY];

/**
 * The measured / asserted / NOT-asserted statement that accompanies each
 * availability class (Constitution §1.5).
 *
 * These strings are part of the public API response. They are written for a
 * developer/relying-party audience, and they are deliberately conservative: the
 * `root_only` text must never read as "this record is unverifiable" (it is
 * anchored, and checkable against the chain), and must never read as "you can
 * verify this document offline from a bundle we gave you" (we did not give you
 * one). Both failure modes are claims problems.
 *
 * NOTE FOR COUNSEL: drafted by engineering. Reviewed against §1.5 and the R-7
 * claims gate but not yet counsel-reviewed. Rendered verbatim from this one
 * export, so a reword is a single-constant change.
 */
export const PROOF_AVAILABILITY_NOTE: Record<ProofAvailability, string> = {
  [PROOF_AVAILABILITY.PER_DOCUMENT]:
    'Measured: Arkova stores a per-document inclusion proof for this record. '
    + 'Asserted: the document fingerprint shown here is included under the '
    + 'committed root referenced by this record\'s anchor receipt, and that '
    + 'inclusion can be recomputed independently from the proof returned by the '
    + 'proof endpoint. '
    + 'Not asserted: anything about the accuracy, authenticity, completeness, or '
    + 'legal effect of the underlying document or of the statements it contains.',

  [PROOF_AVAILABILITY.ROOT_ONLY]:
    'Measured: Arkova does not store a per-document inclusion proof for this '
    + 'record. '
    + 'Asserted: the document fingerprint shown here was committed to the Bitcoin '
    + 'network in the referenced anchor receipt at the recorded time. '
    + 'Not asserted: that a self-contained per-document proof bundle is available '
    + 'from Arkova for offline verification of this record. Verifying this record '
    + 'requires retrieving the referenced anchor receipt from the network. The '
    + 'absence of a stored per-document proof is not evidence that the record is '
    + 'invalid, and says nothing about the accuracy or legal effect of the '
    + 'underlying document.',
};

/** The public field pair. Always produced together — see below. */
export interface ProofAvailabilityFields {
  proof_availability: ProofAvailability;
  proof_availability_note: string;
}

/**
 * Produce the class AND its note as one indivisible value.
 *
 * This returns a pair rather than just the class so the "a class never travels
 * without its meaning" invariant holds BY CONSTRUCTION instead of by convention.
 * With a bare classifier, every emission site had to remember a second
 * `PROOF_AVAILABILITY_NOTE[...]` lookup, and a site that forgot would ship a
 * bare `root_only` — a claim about a record with no statement of what it does
 * and does not assert, which is the exact §1.5 failure this module exists to
 * prevent. A caller now has to visibly discard a field to get that wrong.
 *
 * `hasServableBranch` must come from `hasServableProofBranch` (utils/merkle.ts)
 * — the same predicate `/proof` uses. Callers that did not measure it must not
 * call this at all; see the tri-state note on `has_stored_proof_branch`.
 */
export function proofAvailabilityFields(hasServableBranch: boolean): ProofAvailabilityFields {
  const availability = hasServableBranch
    ? PROOF_AVAILABILITY.PER_DOCUMENT
    : PROOF_AVAILABILITY.ROOT_ONLY;
  return {
    proof_availability: availability,
    proof_availability_note: PROOF_AVAILABILITY_NOTE[availability],
  };
}
