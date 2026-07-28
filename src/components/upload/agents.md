# agents.md — components/upload
_Last updated: 2026-07-28_

## 2026-07-28 R19 — issuer-attestation acknowledgement (advances SCRUM-2481)

`BulkUploadWizard.tsx` `ReviewStep`: when `mapping.fingerprint === null` (no fingerprint column mapped — every valid row becomes record-derived, `fingerprintProvided: false`), renders a `RECORD_ATTESTATION_LABELS` notice + checkbox (`data-testid="record-attestation-notice"` / `"record-attestation-checkbox"`) and disables "Process N Records" until checked. `attested` is wizard-level state threaded into `createBulkAnchors(records, { attested })` — `useBulkAnchors.ts` re-checks it and blocks the RPC call (client-side gate; the SQL layer independently computes the class server-side from `fingerprintProvided`, migration `0376`). Confirmed **`CSVUploadWizard.tsx` is unreachable dead code** (no live JSX render site — `SecureDocumentDialog.tsx` renders `BulkUploadWizard`, not `CSVUploadWizard`); the attestation gate was intentionally NOT added there. If `CSVUploadWizard.tsx` is ever wired up, it needs the same gate before shipping.

## What This Folder Contains
Bulk upload and AI extraction components for CSV/Excel document anchoring workflows.

## Key Files
- `BulkUploadWizard.tsx` — End-to-end wizard for bulk document anchoring via CSV: parsing, validation, backend batch execution with progress tracking
- `CSVUploadWizard.tsx` — Earlier CSV upload wizard with real parsing and bulk anchor creation
- `CsvUploader.tsx` — Spreadsheet uploader handling CSV and Excel (.xlsx/.xls) with email pre-flight checks
- `AIExtractionStep.tsx` — Inserted between review and processing in BulkUploadWizard; sends rows to batch extraction endpoint (Constitution 4A: only structured text, no raw documents)
- `CleBulkImport.tsx` — CLE-specific bulk import component
- `index.ts` — Barrel exports

## Dependencies
- `@/lib/csvParser` — CSV parsing types (CsvColumn, CsvRow, ColumnMapping)
- `@/lib/workerClient` (workerFetch) — batch extraction API
- `@/lib/supabase` — auth token for worker requests

## Do / Don't Rules
- DO: Assemble row text client-side from spreadsheet data — no raw documents flow to server
- DO: Gate AI extraction behind `ENABLE_AI_EXTRACTION` flag

## 2026-07-21 SCRUM-2938 S2 — terminology scrub remainder

BulkUploadWizard mapping label "Document Type". CSV column-name documentation strings (`credential_type`) untouched — they name the real columns. Internal identifiers (keys, enum values, `credential_type`, API params) are unchanged per §1.3 "internal code may use technical names". Contract test: `src/lib/copy-scrum-2938-terminology-s2.test.ts` (walks every copy.ts string value; SCRUM-1672 `ISSUE_CREDENTIAL_LABELS` carve-out locked byte-identical).
