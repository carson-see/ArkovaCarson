# agents.md — components/upload
_Last updated: 2026-05-16_

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
