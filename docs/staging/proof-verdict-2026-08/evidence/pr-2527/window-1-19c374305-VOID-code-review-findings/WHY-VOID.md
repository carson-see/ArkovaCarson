# PR #2527 window 1 — VOID

Clock: 2026-08-31T15:49:02Z, stopped 2026-08-31T15:58Z after 4 clean cycles.
Head: 19c3743054c03ccedddddbbfc38076a44609e0be

VOIDED DELIBERATELY, not by failure. Every cycle was clean (26/26 checks). The
window was stopped because `/code-review` at high effort returned four
substantive findings against the verdict logic this soak exists to exercise.
Soaking code a review has rejected is worthless regardless of how green the
cycles are, so the clock was stopped rather than run to 12h.

Findings that invalidate this window's premise:

1. proofVerdict.ts:186 — every verifyMerkleInclusion rejection maps to
   `invalid`, including non-hex leaf/root/sibling FORMAT faults that return
   before any recompute. Raises a cryptographic alarm on a corrupt row, and
   PROOF_VERDICT_NOTE[INVALID] asserts a "Measured: ... recomputed" that did
   not occur (§1.5 violation).
2. verify-proof.ts:767 — leafCount is a live count(*) over chunked,
   non-transactional writes (500/chunk). A short count yields out-of-range or
   FALSE forged-self-pair rejections -> `invalid` on a sound record, and that
   verdict is cryptographically signed under ?format=signed.
3. verify-proof.ts:670 — structuralGuardArmed measures "options supplied",
   not "guard did work". It ignores verifyMerkleInclusion's empty-branch early
   return, so single-leaf proofs are labelled `unverifiable` though the check
   completed, and armed+empty claims "the duplicate-node structural check was
   armed and passed" when no walk ran.
4. docs.ts:184 — served spec omits `verdict` on the error body and documents
   the indeterminate case as 503 while the code returns 500.

Finding 3 also lands INSIDE this fixture: the two filler rows
(ARK-PRFFIL-000001/2) carry proof_path '[]' with merkle_index 2/3 in batch
BB-PROOF-FIX-A, so leafCount=4 arms the flag over an empty branch — the exact
over-claiming case finding 3 describes. The fixture must gain a probe for it
once the mapping is fixed.

The fixture itself remains valid and is NOT discarded: the three-state
discrimination and the forged-self-pair negative control were both proven
against the real verifier and live over HTTP (see ../NEGATIVE-CONTROL.md).
