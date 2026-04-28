# agents.md — verification
_Last updated: 2026-04-28 (SCRUM-952 hero state machine)_

## What This Folder Contains

Public + authenticated verification UI for `/verify/:publicId` and the
in-app verifier flow. `PublicVerification` is the canonical public-facing
component — rendered by `PublicVerifyPage` when a publicId is in the URL.

## Hero state machine (SCRUM-952, 2026-04-28)

`PublicVerification.tsx` renders one of five hero states keyed off the
public anchor's `status`. The split between `isPreSecured` (PENDING ∪
SUBMITTED) and SECURED is the core trust-signal contract — a SUBMITTED
anchor MUST NOT render the green-check "Document Verified" affordance,
because the network has not yet confirmed the underlying transaction.

- **PENDING** → `Submitting to Network…`, amber clock with `animate-pulse`,
  Processing badge. Cryptographic-proof / evidence-layers / proof-download
  sections are hidden.
- **SUBMITTED** → `Record Submitted · Awaiting Network Confirmation`,
  amber clock (static, no pulse — distinguishes "broadcast, awaiting
  observer" from PENDING's "still being prepared"), `Awaiting Confirmation`
  badge sourced from `ANCHOR_STATUS_LABELS.SUBMITTED`. Cryptographic-proof
  sections still hidden — receipt is broadcast but not yet anchored.
- **SECURED** → `Document Verified`, green CheckCircle, `Secured` badge,
  full cryptographic-proof + evidence-layers + proof-download visible.
- **REVOKED** → `Record Revoked`, gray Ban icon, neutral badge.
- **EXPIRED** → `Record Expired`, amber clock, neutral outline badge.

## Do / Don't Rules

- **DO** drive every hero affordance from `data.status` directly. Adding
  a new `is*` derived flag belongs alongside `isPending`, `isSubmitted`,
  etc. — DO NOT branch on response shape (e.g., presence of `secured_at`)
  to infer the hero state.
- **DO** use `ANCHOR_STATUS_LABELS` for badge text and
  `ANCHORING_STATUS_LABELS` for hero title/subtitle copy. SUBMITTED's
  badge text is shared with the dashboard label and lives in
  `ANCHOR_STATUS_LABELS.SUBMITTED` to keep one source of truth.
- **DON'T** show the green-check / "Document Verified" affordance unless
  `data.status === 'SECURED'`. The 2026-04-21 UAT (BUG-2026-04-21-005)
  showed contradictory signals — that bug is the regression-test target
  in `PublicVerification.test.tsx`.

## Tests

- `PublicVerification.test.tsx` — pins the hero state machine for PENDING /
  SUBMITTED / SECURED, including the "no green-check on SUBMITTED" rule
  and the gating of the cryptographic-proof section behind `!isPreSecured`.
