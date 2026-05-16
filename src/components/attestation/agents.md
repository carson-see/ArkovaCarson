# agents.md — components/attestation
_Last updated: 2026-05-16_

## What This Folder Contains
Attestation (credential issuance) components: bulk issuance wizard and template-driven verification forms.

## Key Files
- `BulkIssuanceWizard.tsx` — Multi-step wizard for bulk-issuing credential attestations via CSV: Upload -> Column Mapping -> Preview -> Processing -> Results
- `EducationVerificationForm.tsx` — Template-driven form for education credential verification (degree, institution, GPA, etc.)
- `EmploymentVerificationForm.tsx` — Template-driven form for employment credential verification
- `EvidenceUpload.tsx` — Attach supporting evidence files to attestations; files fingerprinted client-side (SHA-256), only fingerprint + metadata stored
- `index.ts` — Barrel exports

## Do / Don't Rules
- DO: Fingerprint evidence files client-side only — never send raw files to server
- DO: Use template-driven forms that pre-populate claims from structured fields
