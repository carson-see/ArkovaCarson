# agents.md — verification
_Last updated: 2026-05-19 (SCRUM-1599 source provenance + badge safety)_

## What This Folder Contains

Public + authenticated verification UI for `/verify/:publicId` and the
in-app verifier flow. `PublicVerification` is the canonical public-facing
component — rendered by `PublicVerifyPage` when a publicId is in the URL.

## Hero state machine (SCRUM-952, 2026-04-28)

`PublicVerification.tsx` renders one of five hero states keyed off the
normalized public anchor status from `normalizePublicVerificationStatus()`.
The frozen public API may return `ACTIVE` for a secured anchor; the public UI
must treat that alias as `SECURED` everywhere. The split between pre-secured
(PENDING / SUBMITTED) and terminal proof states (SECURED / REVOKED / EXPIRED)
is the core trust-signal contract — a SUBMITTED anchor MUST NOT render the
green-check "Document Verified" affordance, because the network has not yet
confirmed the underlying transaction.

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
- **REVOKED** → `Record Revoked`, gray Ban icon, neutral badge, terminal
  proof sections visible.
- **EXPIRED** → `Record Expired`, amber clock, neutral outline badge, terminal
  proof sections visible.
- **SUPERSEDED** → `Record Superseded`, gray XCircle, neutral badge, terminal
  proof sections visible. Never collapse this to PENDING or SECURED.

## Source provenance (SCRUM-1599, 2026-05-19)

`PublicVerification.tsx` may receive source provenance either as top-level RPC
fields or from sanitized `metadata`. Use `extractSourceProvenance()` and
`parseVerificationLevel()` rather than casting arbitrary strings. Public
credential-card metadata is defensively filtered for PII and CSI internal fields;
source fields render in `SourceProvenanceDisplay`, and hashes belong in proof
downloads.

## Do / Don't Rules

- **DO** drive every hero affordance from the normalized `publicStatus`.
  Adding a new `is*` derived flag belongs alongside `isPending`, `isSubmitted`,
  etc. — DO NOT branch on response shape (e.g., presence of `secured_at`)
  to infer the hero state.
- **DO** use `ANCHOR_STATUS_LABELS` for badge text and
  `ANCHORING_STATUS_LABELS` for hero title/subtitle copy. SUBMITTED's
  badge text is shared with the dashboard label and lives in
  `ANCHOR_STATUS_LABELS.SUBMITTED` to keep one source of truth.
- **DON'T** show the green-check / "Document Verified" affordance unless the
  normalized status is `SECURED`. The SCRUM-952 UAT closure (BUG-2026-05-15-001)
  showed contradictory signals — that bug is the regression-test target
  in `PublicVerification.test.tsx`.

## Tests

- `PublicVerification.test.tsx` — pins the hero state machine for PENDING /
  SUBMITTED / SECURED / REVOKED / EXPIRED, including the "no green-check on
  SUBMITTED" rule, `ACTIVE` alias normalization, and the gating of proof
  sections behind terminal proof states.
