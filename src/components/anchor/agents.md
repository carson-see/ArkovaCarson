# agents.md — components/anchor
_Last updated: 2026-05-19 (SCRUM-1599 source provenance)_

## What This Folder Contains
Core anchor (document-securing) UI components: upload, confirm, AI extraction, lifecycle timeline, sharing, and verification walkthrough.

## Key Files
- `SecureDocumentDialog.tsx` — Main modal for securing a document: upload -> AI extraction -> template -> confirm -> anchor
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

## Recent Changes
- 2026-05-19 SCRUM-1599: `AssetDetailView.tsx` uses `SourceProvenanceDisplay` for internal record source provenance so internal and public views share URL sanitization/evidence-level rendering. `AnchorLifecycleTimeline.tsx` now treats `SUPERSEDED` as a visible terminal state.
