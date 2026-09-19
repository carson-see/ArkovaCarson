# agents.md — components/upload

## 2026-09-19 — UAT-23 spreadsheet import completion

`BulkUploadWizard` owns row-wise spreadsheet imports; `FileUpload` continues to
offer the separate "one document" path. Row-wise imports use one explicit
queue/instant action and shared description/private-tag defaults for the whole
import while preserving each row's metadata. Successful AI extraction fields
must be merged by row index before submission; do not retain them only for UI.
The wizard always supplies an explicit action to `useBulkAnchors`, which routes
through the authenticated canonical bulk bridge. Uploader ownership is retained;
recipient email/name are linking hints, never authority to create an auth user,
verified profile, membership, or organization access.

## SCRUM-4448 — nested securing wizard layout

`BulkUploadWizard` shrinks within its parent, uses compact mobile progress markers, and stacks column mapping controls and review actions below the small breakpoint. `AIExtractionStep` stacks its action groups on mobile. Browser coverage in `e2e/secure-dialog-layout.spec.ts` includes upload, mapping, extraction idle/in-flight/recovery and processing; successful bulk completion closes the parent dialog immediately by existing design. Record parsing, attestation, extraction and worker payloads are unchanged.

_Last updated: 2026-07-28_

## 2026-07-28 R19 — issuer-attestation acknowledgement (advances SCRUM-2481)

`BulkUploadWizard.tsx` `ReviewStep`: when `mapping.fingerprint === null` (no fingerprint column mapped — every valid row becomes record-derived, `fingerprintProvided: false`), renders a `RECORD_ATTESTATION_LABELS` notice + checkbox (`data-testid="record-attestation-notice"` / `"record-attestation-checkbox"`) and disables "Process N Records" until checked. `attested` is wizard-level state threaded into `createBulkAnchors(records, { attested })` — `useBulkAnchors.ts` re-checks it and blocks the RPC call (client-side gate; the SQL layer independently computes the class server-side from `fingerprintProvided`, migration `0376`). Confirmed **`CSVUploadWizard.tsx` is unreachable dead code** (no live JSX render site — `SecureDocumentDialog.tsx` renders `BulkUploadWizard`, not `CSVUploadWizard`); the attestation gate was intentionally NOT added there. If `CSVUploadWizard.tsx` is ever wired up, it needs the same gate before shipping.
_Last updated: 2026-07-28 (SCRUM-2911 W1)_

## What This Folder Contains
Bulk upload and AI extraction components for CSV/Excel document anchoring workflows, plus the mixed-format batch anchoring wizard (any file types, not spreadsheet rows).

## Key Files
- `BulkUploadWizard.tsx` — End-to-end wizard for bulk document anchoring via CSV: parsing, validation, backend batch execution with progress tracking. CSV-row-only by design — do NOT overload it with non-spreadsheet file handling; see `MixedBatchUploadWizard.tsx` for that.
- `MixedBatchUploadWizard.tsx` (SCRUM-2911 W1, founder P0 2026-07-28) — Secures a batch of files of ANY type in one action. Each file is fingerprinted client-side (`generateFingerprint`, §1.6), then the fingerprint array (never raw bytes) is POSTed to `/api/v1/anchor/bulk/self-service` (the worker's JWT-authed bridge to the API-key-only `/api/v1/anchor/bulk`). Renders per-file fingerprinting progress, then per-file success/duplicate/failure results — duplicates and failures are always visible, never silently swallowed. Routed to from `SecureDocumentDialog.tsx`'s `onMixedBatchDetected` (fired by `FileUpload.tsx` when a multi-file drop contains at least one non-spreadsheet file).
- `CSVUploadWizard.tsx` — Earlier CSV upload wizard with real parsing and bulk anchor creation
- `CsvUploader.tsx` — Spreadsheet uploader handling CSV and Excel (.xlsx/.xls) with email pre-flight checks
- `AIExtractionStep.tsx` — Inserted between review and processing in BulkUploadWizard; sends rows to batch extraction endpoint (Constitution 4A: only structured text, no raw documents)
- `CleBulkImport.tsx` — CLE-specific bulk import component
- `index.ts` — Barrel exports

## Dependencies
- `@/lib/csvParser` — CSV parsing types (CsvColumn, CsvRow, ColumnMapping)
- `@/lib/workerClient` (workerFetch) — batch extraction API + `/api/v1/anchor/bulk/self-service`
- `@/lib/supabase` — auth token for worker requests
- `@/lib/fileHasher` (generateFingerprint) — `MixedBatchUploadWizard.tsx` only; client-side SHA-256

## Do / Don't Rules
- DO: Assemble row text client-side from spreadsheet data — no raw documents flow to server
- DO: Gate AI extraction behind `ENABLE_AI_EXTRACTION` flag
- DO (`MixedBatchUploadWizard.tsx`): only ever send `{fingerprint, filename, document_type}` to the worker — never a `File`/`Blob`/`ArrayBuffer` (§1.6)
- DO NOT: add non-spreadsheet file handling to `BulkUploadWizard.tsx` — that's `MixedBatchUploadWizard.tsx`'s job, keeps the two flows disjoint and low-conflict

## 2026-07-21 SCRUM-2938 S2 — terminology scrub remainder

BulkUploadWizard mapping label "Document Type". CSV column-name documentation strings (`credential_type`) untouched — they name the real columns. Internal identifiers (keys, enum values, `credential_type`, API params) are unchanged per §1.3 "internal code may use technical names". Contract test: `src/lib/copy-scrum-2938-terminology-s2.test.ts` (walks every copy.ts string value; SCRUM-1672 `ISSUE_CREDENTIAL_LABELS` carve-out locked byte-identical).
