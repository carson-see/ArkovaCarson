# agents.md — components/anchor

_Last updated: 2026-07-28 (R19 fingerprint_source, advances SCRUM-2481)_

## 2026-07-28 R19 — document_bytes on the single-doc Secure flow

`SecureDocumentDialog.tsx` now sets `fingerprint_source: 'document_bytes'` on the `validateAnchorCreate(...)` payload for every anchor it creates — this flow always hashes real file bytes client-side via `generateFingerprint` (§1.6), so it is document-derived by construction. See `src/lib/agents.md` for the full evidence-class design.

## What This Folder Contains

Core anchor (document-securing) UI components: upload, confirm, AI extraction, lifecycle timeline, sharing, and verification walkthrough.

## Key Files

- `SecureDocumentDialog.tsx` — Main modal for securing a document: upload -> AI extraction -> template -> confirm -> anchor. Has a **§1.6 fail-closed `privacy-blocked` step** (WEBEXT-03): when `runExtraction` reports `progress.failClosed` (on-device PII model / OCR engine could not run), the dialog routes to a LOUD failure (`PRIVACY_FAIL_CLOSED_LABELS`) stating nothing was sent — distinct from the soft `extraction-failed` recovery. The fail-closed signal is latched in a local (React state is async) inside the progress callback.
- `FileUpload.tsx` — Drag-and-drop file upload with client-side fingerprint generation (never uploaded to server)
- `ConfirmAnchorModal.tsx` — Confirmation step before anchoring a document
- `AIFieldSuggestions.tsx` — Displays AI-extracted credential fields with accept/reject/edit controls (no confidence UI, SCRUM-2914)
- `ExtractionQualityBanner.tsx` — Shows the PII-stripped/invalid-fields notice (no confidence UI, SCRUM-2914)
- `AnchorLifecycleTimeline.tsx` — Chronological progression: Created -> Issued -> Secured -> (Revoked | Expired | Superseded)
- `IntegrityScoreBadge.tsx` — Colored badge for integrity scores (green/amber/red) with breakdown popover
- `AssetDetailView.tsx` / `IntegrityDetailView.tsx` — Detail views for anchored assets and integrity data
- `ShareSheet.tsx` / `LinkedInShare.tsx` — Sharing controls including LinkedIn badge snippet
- `TemplateSelector.tsx` — Credential type template picker
- `VerificationWalkthrough.tsx` — Step-by-step verification guide
- `RevokeAnchorModal.tsx` — Confirmation dialog for anchor revocation
- `AnchorDisclaimer.tsx` — Legal disclaimer text (light + dark variants)
- `NessieInsights.tsx` — Nessie AI insights panel for anchor context
- `ComplianceBadge.tsx` — Compliance status indicator badge
- `index.ts` — Barrel exports

## Do / Don't Rules

- DO: Use `generateFingerprint` client-side only — never import in worker code
- DO: Use copy from `@/lib/copy` — never hardcode user-facing strings
- DO NOT: Upload raw document bytes to the server; only fingerprints + PII-stripped metadata flow server-side
- DO NOT (§1.5): In `AssetDetailView.tsx`, render `createdAt` under the "Network
  Observed Time" label. Gate the network label on `securedAt`; fall back to
  `RECORDS_LIST_LABELS.CREATED_TIME` ("Record Created") for unconfirmed anchors.

## Recent Changes

_The following two entries were lost off `main` by the 2026-07-28 union-merge-driver incident and restored the same day — see `docs/incidents/2026-07-28-agents-md-union-drop-remediation.md`._

- 2026-07-21 SCRUM-2938 S2 — terminology scrub remainder: User-visible "credential(s)" scrubbed to "record(s)/document(s)" in AIFieldSuggestions, ShareSheet, TemplateReviewPanel (field-label maps + share text). Internal identifiers (keys, enum values, `credential_type`, API params) are unchanged per §1.3 "internal code may use technical names". Contract test: `src/lib/copy-scrum-2938-terminology-s2.test.ts` (walks every copy.ts string value; SCRUM-1672 `ISSUE_CREDENTIAL_LABELS` carve-out locked byte-identical).
- 2026-07-21 SCRUM-2911 (PR #1605): extraction-failure error taxonomy the dialog consumes is now fully typed. Soft/benign (routes to `extraction-failed` step — retry / enter manually / anchor without AI metadata): `UnsupportedImageFormatError` (HEIC/TIFF) and NEW `NoTextExtractedError` (scanned image-only PDF / blank photo — `AI_EXTRACTION_LABELS.NO_TEXT_FOUND`). Fail-closed §1.6 (routes to `privacy-blocked` LOUD step): `OcrEngineLoadError`, `NerPiiFailClosedError`, Lane 1 `NERModelLoadError` (by name). An error carrying BOTH benign + fail-closed markers is FAIL-CLOSED (dominance). `SecureDocumentDialog.tsx` itself needed NO change — the existing `failedClosed`-latch else-branch already routes soft failures; routing regression tests added in `SecureDocumentDialog.test.tsx` (soft→extraction-failed NOT privacy-blocked; failClosed→privacy-blocked).
- 2026-07-22 SCRUM-2914 (Founder UI findings, follow-up): `AssetDetailView.tsx` "awaiting confirmation" notice had its own hardcoded "~10 minutes" liability string (separate from the `SecureDocumentDialog` one). Moved to `CONFIRMATION_PROGRESS_LABELS.AWAITING_CONFIRMATION` in `copy.ts` (§1.3 — copy belongs in copy.ts), made timing-neutral.
- 2026-07-22 SCRUM-2914 (Founder UI findings): killed extraction-confidence UI across the flow. `ExtractionQualityBanner.tsx` no longer takes/renders a `confidence` prop — it's the PII-stripped/invalid-fields notice only. `AIFieldSuggestions.tsx` dropped `overallConfidence` and per-field confidence % (accept/reject/edit unaffected). `SecureDocumentDialog.tsx` removed the `reviewComplete` state and the `disabled`/`aria-disabled` wiring on the extraction-review Continue button — the AI-03 confidence-driven block is gone (`TemplateReviewPanel` still renders for field review/edit, its `onReviewStateChange` is now a no-op). `src/components/organization/IssueCredentialForm.tsx` updated to match the `AIFieldSuggestions` prop change.
- 2026-07-17 SCRUM-2910 (BUG-2026-07-17-009/-010, P0): `ExtractionQualityBanner.tsx` no longer renders fraud-signal UI (the `fraudSignals` prop was removed — it rendered Gemini extraction output ungated by ENABLE_FRAUD_DETECTION); `SecureDocumentDialog.tsx` no longer passes fraud data to it. `AssetDetailView.tsx` metadata filter now also hides any `fraud*` key via `isFraudMetadataKey` from `@/lib/fraudDetection`.
- 2026-07-06 AI-03 round-1 review fixes (PR #1413): `SecureDocumentDialog.tsx` zero-field guard — extraction success with zero displayable fields (sparse extraction; template mapper filtered everything) sets `reviewComplete=true` so the absent `TemplateReviewPanel` never soft-locks Continue (same contract as flag-off). Dead per-field accept/reject/accept-all handler wiring removed — the progress-only `AIFieldSuggestions` instance renders with `fields={[]}` so those callbacks can never fire (inline no-ops); post-extraction review is owned by `TemplateReviewPanel`.
- 2026-06-24 BUG-2026-06-24-008: `AssetDetailView.tsx` "Network Observed Time"
  field renders the network label only when `securedAt` is set; otherwise it
  shows an honest "Record Created" label. Tests in `AssetDetailView.test.tsx`.
- 2026-06-23 WEBEXT-03 (SCRUM-2505): `SecureDocumentDialog.tsx` gained the §1.6 fail-closed `privacy-blocked` step + `ShieldAlert` loud-failure UI. When the on-device PII model / OCR engine fails, the dialog no longer falls through to the soft "secure without metadata" recovery — it shows an explicit "On-Device Privacy Protection Unavailable" state (Reload / Continue Without AI Metadata) and states nothing was sent. UAT screenshots needed at 1280px + 375px.
- 2026-05-26 SCRUM-2013: `SecureDocumentDialog.tsx` AI fuzzy type map expanded to align with the canonical credential taxonomy, including `CPE`, `ACCREDITATION`, `CONTRACT_PRESIGNING`, and `CONTRACT_POSTSIGNING`.
- 2026-05-19 SCRUM-1599: `AssetDetailView.tsx` uses `SourceProvenanceDisplay` for internal record source provenance so internal and public views share URL sanitization/evidence-level rendering. `AnchorLifecycleTimeline.tsx` now treats `SUPERSEDED` as a visible terminal state.
