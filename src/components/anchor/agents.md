# agents.md — components/anchor

_Last updated: 2026-05-26 (SCRUM-2013 credential type drift fix)_

## What This Folder Contains

Core anchor (document-securing) UI components: upload, confirm, AI extraction, lifecycle timeline, sharing, and verification walkthrough.

## Key Files

- `SecureDocumentDialog.tsx` — Main modal for securing a document: upload -> AI extraction -> template -> confirm -> anchor. Has a **§1.6 fail-closed `privacy-blocked` step** (WEBEXT-03): when `runExtraction` reports `progress.failClosed` (on-device PII model / OCR engine could not run), the dialog routes to a LOUD failure (`PRIVACY_FAIL_CLOSED_LABELS`) stating nothing was sent — distinct from the soft `extraction-failed` recovery. The fail-closed signal is latched in a local (React state is async) inside the progress callback.
- `FileUpload.tsx` — Drag-and-drop file upload with client-side fingerprint generation (never uploaded to server)
- `ConfirmAnchorModal.tsx` — Confirmation step before anchoring a document
- `AIFieldSuggestions.tsx` — Displays AI-extracted credential fields with confidence badges and accept/reject/edit controls
- `ExtractionQualityBanner.tsx` — Shows extraction confidence level and provider info
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

- 2026-06-24 BUG-2026-06-24-008: `AssetDetailView.tsx` "Network Observed Time"
  field renders the network label only when `securedAt` is set; otherwise it
  shows an honest "Record Created" label. Tests in `AssetDetailView.test.tsx`.
- 2026-06-23 WEBEXT-03 (SCRUM-2505): `SecureDocumentDialog.tsx` gained the §1.6 fail-closed `privacy-blocked` step + `ShieldAlert` loud-failure UI. When the on-device PII model / OCR engine fails, the dialog no longer falls through to the soft "secure without metadata" recovery — it shows an explicit "On-Device Privacy Protection Unavailable" state (Reload / Continue Without AI Metadata) and states nothing was sent. UAT screenshots needed at 1280px + 375px.
- 2026-05-26 SCRUM-2013: `SecureDocumentDialog.tsx` AI fuzzy type map expanded to align with the canonical credential taxonomy, including `CPE`, `ACCREDITATION`, `CONTRACT_PRESIGNING`, and `CONTRACT_POSTSIGNING`.
- 2026-05-19 SCRUM-1599: `AssetDetailView.tsx` uses `SourceProvenanceDisplay` for internal record source provenance so internal and public views share URL sanitization/evidence-level rendering. `AnchorLifecycleTimeline.tsx` now treats `SUPERSEDED` as a visible terminal state.
