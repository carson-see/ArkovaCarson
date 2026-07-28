# agents.md — verification
_Last updated: 2026-07-28 (R19 fingerprint-source evidence class, advances SCRUM-2481)_
_Last updated: 2026-07-06 (SCRUM-2501 FE-PROOF-GATE proof-availability state machine)_
_Last updated: 2026-07-06 (SCRUM-2495 does-not-assert disclaimer)_

## 2026-07-28 R19 — FingerprintSourceDisplay (advances SCRUM-2481)

New `FingerprintSourceDisplay.tsx` (mirrors `EvidenceLevelBadge.tsx` + `SourceProvenanceDisplay.tsx`) renders the `fingerprint_source` evidence class — document-derived (`document_bytes`) vs record-derived issuer attestation (`issuer_record_attestation`) — with a measured/asserted/NOT-asserted triad per §1.5. Wired into `PublicVerification.tsx` as SECTION 2d, immediately before Source Provenance (2e) — orthogonal axis, renders nothing for unclassified (pre-`0376`) anchors. Backed by `@/lib/fingerprintSource.ts`. Do NOT add these two values to the `EvidenceLevel` union in `@/lib/sourceProvenance.ts` / `EvidenceLevelBadge.tsx` — they classify a different thing (source-import authentication tier vs what-was-hashed). R-7 invariant: `issuer_record_attestation` copy must never state or imply Arkova received a source document — enforced by `FingerprintSourceDisplay.test.tsx`.

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

## Proof availability state machine (SCRUM-2501, 2026-07-06)

`VerifierProofDownload.tsx` no longer downloads a hand-assembled JSON subset
gated only on status. It calls `GET /api/v1/verify/:publicId/proof` (public,
anonymous) via `useProofAvailability` and renders per
`docs/reference/FE_PROOF_GATE_CONTRACT.md`:

- **State 1** (`200` + `verified: true` + `proof_bundle !== null`) → live
  download control; the downloaded artifact is the `proof_bundle` object
  VERBATIM — never rebuilt, augmented, or renamed (the bundle's `tx_id` /
  `block_header` field names are the frozen API contract, exempt from §1.3).
- **State 1b** (`200` + `proof_bundle: null`) and **state 2** (`404` "No
  Merkle proof available…" — the ~2.97M direct-anchored back catalogue) →
  honest empty-state (`PROOF_AVAILABILITY_LABELS.NOT_YET_AVAILABLE_*`):
  NO download control, NO disabled button, NO error toast.
- **State 3** (not SECURED) → the component returns `null` without fetching;
  the page hero ("Submitting to Network…", proof sections hidden) is the
  securing-in-progress presentation.
- `404` `Record not found` → real error state (`proof-record-missing`),
  distinct from state 2. `429` → render nothing (transient). `5xx` /
  `verified: false` on 200 / network failure → retryable affordance
  (`proof-retry`), never state-2 copy.

The FE gate is `isProofDownloadable(status) && 200 && verified === true &&
proof_bundle !== null` (belt-and-braces status check per contract §3 — the
route itself is proof-existence-gated, not status-gated). Classification is
pure in `src/lib/proofAvailability.ts`; fetch in
`src/hooks/useProofAvailability.ts`. E2E: `e2e/public-proof-gate.spec.ts`.
The PROOF-04 PDF path (`ENABLE_PROOF_PDF_DOWNLOAD`) is untouched and stays
default-OFF.

## Source provenance (SCRUM-1599, 2026-05-19)

`PublicVerification.tsx` may receive source provenance either as top-level RPC
fields or from sanitized `metadata`. Use `extractSourceProvenance()` and
`parseVerificationLevel()` rather than casting arbitrary strings. Public
credential-card metadata is defensively filtered for PII and CSI internal fields;
source fields render in `SourceProvenanceDisplay`, and hashes belong in proof
downloads.

## Badge / provenance honesty (SCRUM-2481, 2026-07-07)

`EvidenceLevelBadge` and `SourceProvenanceDisplay` are structurally honest about
what each evidence tier proves — this is a launch blocker, not cosmetics.

- The green "issuer-verified" treatment is routed EXCLUSIVELY through
  `isIssuerAuthenticated()` (`src/lib/sourceProvenance.ts`), true ONLY for
  `issuer_anchored` and `source_signed`. `account_linked` / `captured_url` /
  `ai_captured` can NEVER earn green or any issuer-family wording
  ("Verified" / "Issuer" / "Authenticated"). Do NOT gate green on
  `isStrongEvidence` at the badge — that is the strength ordering, not the
  issuer-auth gate.
- Every tier carries a distinct `data-evidence-tier` and a distinct, honest
  `aria-label`. `SourceProvenanceDisplay` also renders the §1.5
  measured / asserted / NOT-asserted triad; every non-issuer tier lists
  "issuer identity" under NOT-asserted.
- The honesty invariant covers the `showDescription` TOOLTIP too, not just the
  alt/triad. The tooltip body is `getEvidenceLevelDescription()` →
  `EVIDENCE_LEVEL_DESCRIPTIONS` (`src/lib/copy.ts`), rendered on the public
  (unauthenticated) verification page. `account_linked`'s description used to read
  "Imported from an *authenticated* account…" — a non-issuer tier surfacing
  "authenticated" on an off-platform surface (§1.5 / R-7). It now reads "Imported
  from a connected account. Proves the holder had access to that account — the
  originating organization did not vouch for this record." Pinned by
  `sourceProvenance.test.ts` ("non-issuer tier DESCRIPTIONS carry no issuer-family
  wording").
- The alt / triad strings currently live as LOCAL CONSTS in the two components
  (`TIER_ALT_FALLBACK`, `EVIDENCE_TRIAD_FALLBACK`, `SOURCE_PROVENANCE_TRIAD_LABELS`)
  because the canonical block `// ─── SCRUM-2481 badge honesty (Lane 3) ───` in
  `src/lib/copy.ts` is HELD to land after the copy.ts-touching soaking PRs merge.
  Once that block lands, swap the components to import `EVIDENCE_LEVEL_BADGE_ALT`
  / `EVIDENCE_TRIAD` / `EVIDENCE_TRIAD_LABELS` from `@/lib/copy` — the strings are
  identical, so it is a no-op. **Parity is now enforced**: `EvidenceLevelBadge.test.tsx`
  pins the rendered `aria-label` to `EVIDENCE_LEVEL_BADGE_ALT` and
  `SourceProvenanceDisplay.test.tsx` pins the rendered triad rows/labels to
  `EVIDENCE_TRIAD` / `EVIDENCE_TRIAD_LABELS`, so a one-sided edit that drifts a
  fallback from copy.ts canon fails red (this closes the "dead export could
  silently diverge" gap). These per-tier guards stay green after the swap.
- The honesty gate ALSO covers the off-platform SHARE/EMBED affordance, not just
  the badge colour/triad. `PublicVerification.tsx` Section 2f (the embeddable
  `ArkovaBadge` + the `LinkedInCredentialHelper` Credential-URL helper) is gated
  on `canShareIssuerBadge` = `isSecured && isIssuerAuthenticated(level)` — the
  SAME `isIssuerAuthenticated()` gate as the green treatment. A merely-SECURED
  low-trust record (`captured_url` / `account_linked` / `ai_captured`) — or a
  plain upload with NO `verification_level` — must NEVER surface a shareable /
  embeddable issuer-looking badge (SCRUM-2481 [P1], §1.5 / R-7 claims-gate).
  Pinned in `PublicVerification.test.tsx` (absent for captured_url /
  account_linked / no-level; present only for issuer_anchored / source_signed).
- Deferred post-soak (Carson-gated): the worker `verification_level` mapping fn
  and the DB CHECK migration that enforces the tier enum are NOT in this slice —
  they touch soaking surfaces.

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
  sections behind terminal proof states, and the "no compliance controls
  unless SECURED" rule (BUG-2026-06-24-007).
- `EvidenceLevelBadge.test.tsx` — per-tier `data-evidence-tier` + distinct
  `aria-label` + distinct icon, green ONLY for issuer tiers, no issuer-family
  wording on non-issuer alt text, and the copy.ts-canon parity guard for the
  rendered alt text.
- `SourceProvenanceDisplay.test.tsx` — triad renders per tier, non-issuer tiers
  state "issuer identity" NOT-asserted, issuer tiers omit that disclaimer, and the
  copy.ts-canon parity guard for the rendered triad rows/labels.
- `src/lib/sourceProvenance.test.ts` — the issuer-auth gate (`isIssuerAuthenticated`
  ⊆ strong) plus the non-issuer DESCRIPTION honesty guard (no "Verified" /
  "Issuer" / "Authenticated" in the public tooltip body).
  sections behind terminal proof states, the "no compliance controls
  unless SECURED" rule (BUG-2026-06-24-007), and the does-not-assert
  disclaimer's unconditional presence (SCRUM-2495).
- `DoesNotAssertDisclaimer.test.tsx` — pins the MEASURED/ASSERTED/NOT-ASSERTED
  substance, the "always visible, no reveal needed" contract, a banned-terms
  regression guard, and basic rendering at 1280px/375px container widths.

## Fraud metadata redaction (SCRUM-2910, 2026-07-17)

BUG-2026-07-17-010 (P0): historical `fraud_*` metadata keys (fraud_score,
fraud_risk_level, fraud_signals, camelCase `fraudSignals`, ...) rendered on the
PUBLIC verification page because no hidden-key filter covered the prefix.
`sanitizeCredentialMetadata` in `PublicVerification.tsx` now also drops any key
matched by `isFraudMetadataKey` (`@/lib/fraudDetection`) — a normalized-prefix
check, conservative by design. Regression test: "never renders fraud_* metadata
keys" in `PublicVerification.test.tsx`. Never re-surface fraud data on any
public or owner display surface.

**2026-07-21 (SCRUM-2910 remainder):** `MetadataDisplay.tsx` — a generic
key-value metadata renderer exported from this barrel — now applies the same
`isFraudMetadataKey` filter (plus the `_`-prefix internal-key drop). It is NOT
currently mounted in any prod render path (exported for reuse only), so this is
defense-in-depth against a future re-mount, not a live-leak fix. A durable STATIC
guard (`src/tests/scrum-2910-fraud-filter-coverage.test.ts`) now scans every
non-test file under `src/components` and FAILS if any file that iterates a
freeform `metadata`/`meta` blob for rendering omits `isFraudMetadataKey` — this
catches a brand-new renderer, not just the enumerated ones. If you add a metadata
renderer, apply the filter or add an ALLOWLIST entry with a reason.

## 2026-07-21 SCRUM-2938 S2 — terminology scrub remainder

_Restored 2026-07-28 — lost off `main` by the union-merge-driver incident (see `docs/incidents/2026-07-28-agents-md-union-drop-remediation.md`)._

EvidenceLayersSection "Not present for this record."; EvidenceLevelBadge + SourceProvenanceDisplay local fallback triads scrubbed in lockstep with the canonical copy.ts EVIDENCE_TRIAD/EVIDENCE_LEVEL_BADGE_ALT strings (credential → document). Internal identifiers (keys, enum values, `credential_type`, API params) are unchanged per §1.3 "internal code may use technical names". Contract test: `src/lib/copy-scrum-2938-terminology-s2.test.ts` (walks every copy.ts string value; SCRUM-1672 `ISSUE_CREDENTIAL_LABELS` carve-out locked byte-identical).
