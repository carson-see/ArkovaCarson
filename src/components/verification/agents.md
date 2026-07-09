# agents.md — verification
_Last updated: 2026-07-06 (SCRUM-2495 does-not-assert disclaimer)_

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
- **DON'T** render the `ComplianceBadge` (SOC2/HIPAA/eIDAS controls) for any
  non-`SECURED` status. Compliance controls describe protections of a *securely
  anchored* credential; advertising them next to a REVOKED/SUPERSEDED/EXPIRED
  banner is a §1.5/§1.13 claims-gate violation. Gate the section on `isSecured`
  and pass the real `isSecured` to `ComplianceBadge` — never hardcode `true`
  (BUG-2026-06-24-007, regression-pinned in `PublicVerification.test.tsx`).

## Does-Not-Assert Disclaimer (SCRUM-2495, 2026-07-06)

`DoesNotAssertDisclaimer.tsx` renders an always-visible MEASURED / ASSERTED /
NOT ASSERTED block (CLAUDE.md §1.5) at the bottom of `PublicVerification.tsx`,
below the proof-download section. It replaces the prior ad-hoc disclaimer
paragraph that was written directly in JSX (a §6 "text directly in JSX"
violation) and that also contained a live §1.3 banned-terminology violation
("Bitcoin blockchain") — invisible to `npm run lint:copy` only because the
scanner's line-based heuristic requires a quote or a same-line `<`/`>` pair,
and the two banned words happened to land on an unquoted, tag-free JSX text
line. `DoesNotAssertDisclaimer.test.tsx` carries an independent banned-terms
regex as a second line of defense against that exact scanner blind spot.

- **DO** render this component unconditionally (not gated behind `hasProof`
  or any status check) — it applies to every anchor status, not just SECURED.
- **DON'T** hide it behind a tooltip, hover, or click-to-reveal affordance —
  CLAUDE.md §1.6 UAT requires it to be visibly present without interaction.
- **DON'T** inline disclaimer copy in JSX — add/edit strings in
  `DOES_NOT_ASSERT_LABELS` (`src/lib/copy.ts`) only.

## Tests

- `PublicVerification.test.tsx` — pins the hero state machine for PENDING /
  SUBMITTED / SECURED / REVOKED / EXPIRED, including the "no green-check on
  SUBMITTED" rule, `ACTIVE` alias normalization, the gating of proof
  sections behind terminal proof states, the "no compliance controls
  unless SECURED" rule (BUG-2026-06-24-007), and the does-not-assert
  disclaimer's unconditional presence (SCRUM-2495).
- `DoesNotAssertDisclaimer.test.tsx` — pins the MEASURED/ASSERTED/NOT-ASSERTED
  substance, the "always visible, no reveal needed" contract, a banned-terms
  regression guard, and basic rendering at 1280px/375px container widths.
