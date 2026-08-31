/**
 * Tri-state proof verdict — R3.
 *
 * WHY THIS EXISTS
 *
 * `GET /api/v1/verify/:publicId/proof` reports the app-tree inclusion check as
 * a BOOLEAN `verified`. A boolean has two buckets for three outcomes, so it
 * conflates two states whose consequences for a relying party are opposite:
 *
 *   - "the cryptography FAILED" — an alarm; stop, investigate the record;
 *   - "the check could not be completed" — not an alarm; retry, or fetch the
 *     missing evidence.
 *
 * A boolean must put the second one somewhere. It cannot go in `false` (that
 * cries wolf on a record that may be perfectly sound), so today it rides in
 * `true` — indistinguishable from a clean pass. `verdict` gives it its own
 * bucket without moving anything that already exists.
 *
 * WHAT IS MEASURED
 *
 * `verdict` describes EXACTLY the same computation as `verified`: the layer-1
 * app-tree recompute-and-compare performed by `utils/merkle-verify.ts`
 * (`verifyMerkleInclusion`), plus whether that function's CVE-2012-2459
 * structural guard was armed for the call. It is NOT widened to cover layer-2
 * (whether the committed root appears in a confirmed network receipt) — that
 * question is answered by `proof_bundle`, which is separately nullable and
 * separately documented. Widening the scope would produce `verified: true`
 * next to `verdict: 'unverifiable'` for reasons a reader cannot connect to
 * `verified`, which is precisely the contradiction this field must not create.
 *
 * VOCABULARY NOTE. The three-value shape (and the rule that there is no fourth)
 * is borrowed from IETF draft-fassbender-scitt-time-anchor-05 §3.3 because the
 * reasoning is sound. This is NOT an implementation of that specification: no
 * conformance is claimed, no other requirement of it is imported, and the draft
 * is deliberately not referenced in any user-facing copy (R-7 claims gate).
 *
 * ON REASON CODES. A machine-stable reason vocabulary for this exact failure
 * space ALREADY EXISTS and is frozen at `reason_enum_version 1.0.0`
 * (`packages/verifier-cli/src/lib/reason-codes.ts`), mirrored in the CLI
 * fixtures manifest and re-derived independently by the Python verifier. This
 * module deliberately does NOT mint a second one on the API response — see the
 * decision record in `services/worker/src/constants/agents.md`.
 */

import type { MerkleInclusionResult } from '../utils/merkle-verify.js';

/**
 * The three outcomes of the inclusion check. EXACTLY three — a fourth value
 * would re-open the conflation this field exists to close.
 *
 * - `valid`        — every check this endpoint claims to run, ran, and passed.
 * - `invalid`      — a check RAN and FAILED. An alarm state. Never returned
 *                    because evidence was missing.
 * - `unverifiable` — a check this endpoint claims to run could not be
 *                    completed. NOT an alarm; the record may be perfectly
 *                    sound and the correct response is to retry or to fetch
 *                    the missing evidence.
 */
export const PROOF_VERDICT = {
  VALID: 'valid',
  INVALID: 'invalid',
  UNVERIFIABLE: 'unverifiable',
} as const;

export type ProofVerdict = (typeof PROOF_VERDICT)[keyof typeof PROOF_VERDICT];

/**
 * The measured / asserted / NOT-asserted statement for each verdict (§1.5).
 *
 * These strings are part of the public API response, and they carry the same
 * legal weight as `PROOF_AVAILABILITY_NOTE` — same rules apply: drafted by
 * engineering, NOT counsel-reviewed, rendered verbatim from this one export, so
 * a reword is a single-constant change.
 *
 * The `unverifiable` text is the load-bearing one. A bare token can be misread
 * as a verdict against the document; the note is what makes the distinction
 * survive contact with a reader who is skimming. The `invalid` text is the
 * other hazard in the opposite direction: a failed recompute is a reason to
 * investigate the RECORD, and is not by itself evidence that a document was
 * altered or that anyone acted improperly (R-7).
 */
export const PROOF_VERDICT_NOTE: Record<ProofVerdict, string> = {
  [PROOF_VERDICT.VALID]:
    'Measured: the document fingerprint shown here was recomputed against the '
    + 'stored inclusion branch and matches the committed root, and the '
    + 'duplicate-node structural check was armed and passed. '
    + 'Asserted: this fingerprint is included under the root committed by the '
    + "record's anchor receipt. "
    + 'Not asserted: that the committed root has itself been confirmed on the '
    + 'production network — that is a separate check, made against the anchor '
    + 'receipt and the self-contained proof bundle. Nothing is asserted about '
    + 'the accuracy, authenticity, completeness, or legal effect of the '
    + 'underlying document or of the statements it contains.',

  [PROOF_VERDICT.INVALID]:
    'Measured: the document fingerprint shown here was recomputed against the '
    + 'stored inclusion branch and the check did not pass. '
    + 'Asserted: the inclusion evidence stored for this record does not '
    + 'establish that this fingerprint sits under the committed root. '
    + 'Not asserted: that the underlying document was altered, or that any '
    + 'party acted improperly. A failure here can equally mean the stored '
    + 'proof data is corrupt or was recorded incorrectly. Treat this as a '
    + 'signal to investigate the record, not as a determination about the '
    + 'document.',

  [PROOF_VERDICT.UNVERIFIABLE]:
    'Measured: the inclusion check could not be completed in full for this '
    + 'record, because evidence it requires was not available. '
    + 'Asserted: nothing about whether this fingerprint is, or is not, '
    + 'included under the committed root. '
    + 'Not asserted: that this record is invalid. This is the absence of a '
    + 'completed check, not a failed one — a record can be unverifiable here '
    + 'and still be correctly anchored. Retrieve the anchor receipt, or '
    + 'request again once the missing proof data is available.',
};

/** The public field pair. Always produced together — see below. */
export interface ProofVerdictFields {
  verdict: ProofVerdict;
  verdict_note: string;
}

/**
 * Produce the verdict AND its §1.5 note as one indivisible value.
 *
 * Same rationale as `proofAvailabilityFields` / `connectorFingerprintRederivabilityFields`:
 * a bare class shipping without its statement of what it does NOT assert is the
 * exact §1.5 failure these modules exist to prevent, and a hand-written second
 * lookup at each emission site is how that happens. A caller now has to visibly
 * discard a field to get it wrong.
 */
export function proofVerdictFields(verdict: ProofVerdict): ProofVerdictFields {
  return { verdict, verdict_note: PROOF_VERDICT_NOTE[verdict] };
}

/**
 * THE MAPPING. Derive the tri-state verdict from the SINGLE inclusion
 * computation that also produces the boolean `verified`.
 *
 * K1 (divergence) is closed by construction, not by convention: this function
 * takes the `MerkleInclusionResult` that `verified` is read from, so the two
 * fields cannot be computed from different runs or different inputs. The
 * resulting relationship is a strict REFINEMENT of the boolean, never a
 * contradiction of it:
 *
 *     verdict === 'invalid'       <=>  verified === false
 *     verdict === 'valid'          =>  verified === true
 *     verdict === 'unverifiable'   =>  verified === true
 *
 * `valid` and `unverifiable` partition the old `true` bucket; `false` is
 * untouched. No existing consumer sees a changed `verified`.
 *
 * @param inclusion            the result of `verifyMerkleInclusion` — the same
 *                             object `verified` is read from.
 * @param structuralGuardArmed whether the CVE-2012-2459 duplicate-node guard
 *                             was actually live for THAT call. It arms only
 *                             when both a leaf index and a leaf count >= 1 were
 *                             supplied; see the caller.
 *
 * WHY A PASSING RECOMPUTE WITH AN UNARMED GUARD IS `unverifiable`, NOT `valid`.
 * This is the judgement call at the centre of R3, and it is decided on §1.5 /
 * K4 honesty grounds. When the guard is not armed, `verifyMerkleInclusion`
 * still recomputes and compares, and that comparison genuinely passed — so
 * `verified: true` is correct and stays. But a structurally FORGED branch (a
 * self-pair at a position where the tree never duplicated a node) also
 * recomputes to the committed root: the repo's own test suite pins exactly
 * that case as `verified: true` and calls it documented residual risk
 * (`api/v1/verify-proof.test.ts`, "structural guard cannot arm — documents the
 * residual risk"). Reporting that as `valid` would mean the new field carries
 * two meanings in one token — "everything passed" and "everything I was able
 * to check passed" — which is the same conflation `verified` already has and
 * the reason this field is being added. `unverifiable` names what actually
 * happened, and the note says the record may still be correctly anchored so
 * the honest answer cannot be misread as an accusation.
 *
 * The cost is real and is not hidden: this moves a large share of the
 * back-catalogue from an implied clean bill of health to "we did not complete
 * this check", which is the correct answer per K4.
 */
export function classifyInclusionVerdict(
  inclusion: MerkleInclusionResult,
  structuralGuardArmed: boolean,
): ProofVerdict {
  // A completed check that failed is an alarm, whatever the guard did. Guard
  // arming may only ever DOWNGRADE a pass; it can never launder a failure.
  if (!inclusion.valid) return PROOF_VERDICT.INVALID;
  return structuralGuardArmed ? PROOF_VERDICT.VALID : PROOF_VERDICT.UNVERIFIABLE;
}
