# agents.md — credentials
_Last updated: 2026-06-01 (SCRUM-1847 CPE R1 — review fixes)_

## What This Folder Contains
Credential display components. `CredentialRenderer` is the core component that renders a credential using template field schema + anchor metadata. `CredentialTemplatesManager` handles CRUD for credential templates. `CpeMetadataSection` + `NasbaStatusBadge` render CPE (Continuing Professional Education) compliance metadata.

## Recent Changes
- 2026-06-01 SCRUM-1847 (CPE R1 review fixes): (1) Reachability — `src/pages/RecordDetailPage.tsx` now passes `hasImportEntitlement` (from `useHasCredentialImportEntitlement`) + `cpeMetadata` (from the anchor's `cpe_metadata` column, already selected by `useAnchor`'s `select('*')`) into `AssetDetailView`, so the detail-view CPE section is actually reachable. The earlier "RecordDetailPage is locked" caveat was incorrect — no open PR touches that file. (2) Grant-scope docs — `useHasCredentialImportEntitlement.ts` now documents that the gate is inert/fails-closed until the CSI track (SCRUM-1611) ships a `credential_source_import` writer, and that the grant is ORG-WIDE by current RLS/hook design. (3) Formatter robustness — `cpeMetadataView.ts` `num()` now rejects negative `credit_hours` to null (no "-3.0 CPE credits"); `CpeMetadataSection.tsx` `formatDate()` returns null on an unparseable date and the completion-date row is dropped (no "Invalid Date"). Also de-fragiled the public-view snapshot by normalizing React `useId` tokens.
- 2026-05-31 SCRUM-1847 (CPE R1): Added `NasbaStatusBadge.tsx` (3 NASBA registry states — confirmed/green, unknown/amber, not_found/red — with the legal disclaimer sourced from `cpeComplianceCopy.ts`, exposed via an accessible aria-describedby description so it is reachable without a hover), `CpeMetadataSection.tsx` (detail + public CPE display; renders fields from an EXPLICIT allowlist so `extraction_confidence`/`extraction_source` can never leak; review banner on `requires_manual_review`; detail-view gated on the `credential_source_import` entitlement, public view ungated), `cpeMetadataView.ts` (raw `cpe_metadata` → typed `CpeMetadataView`, with the same redaction as a second layer), and `cpeComplianceCopy.ts` (folder-local copy const — `src/lib/copy.ts` was locked; follows the SCRUM-2214 `SUB_ORG_STATE_COPY` precedent; banned-term-free). `CredentialRenderer.tsx` gained 3 optional props (`cpeMetadata`, `hasImportEntitlement`, `publicView`) and mounts `CpeMetadataSection`. Wired into `PublicVerification.tsx` (publicView) and `AssetDetailView.tsx` (entitlement via a `hasImportEntitlement` prop the parent page supplies, mirroring `canRevoke`). Entitlement is read-only via the new `src/hooks/useHasCredentialImportEntitlement.ts` (queries the existing `entitlements` table).
- 2026-05-19 SCRUM-1599: `CredentialRenderer.tsx` includes a neutral `SUPERSEDED` status color so superseded records stay visibly terminal instead of falling back to an unstyled badge.
- 2026-04-28 SCRUM-952: `CredentialRenderer.tsx` — when `credential_type` resolves to "Other" (unknown or genuinely OTHER) but `metadata.sub_type` carries a recognized subtype like `professional_certification`, surface the subtype as the user-visible Type label via the new `formatCredentialSubType()` helper in `src/lib/copy.ts`. Key precedence: `metadata.sub_type` (canonical schema column per migration 0213) wins over `metadata.subtype` (legacy Gemini extraction-payload alias). Prevents UAT report BUG-2026-04-21-005 second issue (Type=Other for known subtypes).
- 2026-03-16 UF-01: Created `CredentialRenderer.tsx` — 3 rendering modes (template+metadata, metadata-only, filename-only). Compact mode for table rows. Fingerprint copy-to-clipboard. 20 unit tests.
- 2026-03-16 UF-01: Updated `index.ts` — barrel exports for CredentialRenderer + CredentialRendererProps.

## Do / Don't Rules
- DO: Use `useCredentialTemplate` hook (in `src/hooks/`) to fetch template data
- DO: Follow Precision Engine design system — sharp corners (`rounded-sm`), `shadow-neon`, `animate-in-view`, `font-mono` for fingerprints. See `docs/reference/BRAND.md`.
- DO: Handle all 3 rendering modes gracefully (template+metadata, metadata-only, no-metadata)
- DON'T: Expose internal template config in public-facing renders — only rendered output
- DON'T: Format dates without `timeZone: 'UTC'` — causes off-by-one day errors. `formatDate` in `CpeMetadataSection` returns null on an unparseable date and the row is dropped; never render the literal "Invalid Date".
- DON'T: Carry an out-of-range numeric metadata value to the UI — `cpeMetadataView`'s `num()` rejects negative `credit_hours` to null so the renderer cannot show "-3.0 CPE credits". Apply the same `min` guard to any new non-negative numeric field.
- DON'T: Render compliance metadata by iterating the raw object — `CpeMetadataSection`/`cpeMetadataView` use an explicit field allowlist so internal extraction signals (`extraction_confidence`, `extraction_source`) never reach the DOM. Keep CLE/CPE additions on the allowlist.
- DON'T: Hardcode the NASBA disclaimer or review-banner strings inline — they live in `cpeComplianceCopy.ts` (verbatim, legally reviewed).
- DO: Gate the CPE section's detail view on the `credential_source_import` entitlement (read-only). Public verification is cross-tenant by design — the public view is intentionally ungated.

## Dependencies
- `@/hooks/useCredentialTemplate` — template data fetching
- `@/hooks/useHasCredentialImportEntitlement` — read-only `credential_source_import` entitlement gate (CPE detail view)
- `@/lib/copy` — `CREDENTIAL_TYPE_LABELS`, `ANCHOR_STATUS_LABELS`, `CREDENTIAL_RENDERER_LABELS`
- `@/lib/sourceProvenance` — `getEvidenceLevelLabel` (CPE evidence-level formatting)
- `./cpeComplianceCopy` — local CPE copy const (NASBA labels, disclaimer, review banner)
- `@/components/ui/badge`, `@/components/ui/button`, `@/components/ui/tooltip` — shadcn/ui primitives
