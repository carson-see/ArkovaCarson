# agents.md — components/attestation
_Last updated: 2026-05-27_

## What This Folder Contains
Attestation (credential issuance) components: status display, verification result, notarization badge, bulk issuance wizard, and template-driven verification forms.

## Key Files
- `AttestationStatusCard.tsx` — (SCRUM-1874) Displays attestation status with color-coded icon, label, description. Supports all 6 statuses: DRAFT, PENDING, ACTIVE, REVOKED, EXPIRED, CHALLENGED. Used in AttestationsPage detail panel and PublicAttestationVerifyPage.
- `NotarizationBadge.tsx` — (SCRUM-1874) Visual indicator for DocuSign notarization and e-signature. Shows notary details (name, commission, state) and envelope ID from `legally_binding_attestations` table. Renders nothing when no data present.
- `VerificationResultDisplay.tsx` — (SCRUM-1874) Chain proof verification result: resolves passed/failed/pending state from attestation status + chain proof presence. Shows fingerprint, network receipt, network checkpoint, network observed time with copy-to-clipboard. Uses CLAUDE.md-compliant terminology throughout.
- `BulkIssuanceWizard.tsx` — Multi-step wizard for bulk-issuing credential attestations via CSV: Upload -> Column Mapping -> Preview -> Processing -> Results
- `EducationVerificationForm.tsx` — Template-driven form for education credential verification (degree, institution, GPA, etc.)
- `EmploymentVerificationForm.tsx` — Template-driven form for employment credential verification
- `EvidenceUpload.tsx` — Attach supporting evidence files to attestations; files fingerprinted client-side (SHA-256), only fingerprint + metadata stored
- `index.ts` — Barrel exports

## Tests
- `AttestationStatusCard.test.tsx` — 10 tests: all 6 status states, public ID, type badge, banned-term check
- `NotarizationBadge.test.tsx` — 8 tests: empty render, notarized badge, notary details, e-sign, combined, font-mono, banned-term check
- `VerificationResultDisplay.test.tsx` — 10 tests: passed/pending/failed states, fingerprint, receipt, checkpoint, timestamp, clipboard, banned-term check

## Do / Don't Rules
- DO: Fingerprint evidence files client-side only — never send raw files to server
- DO: Use template-driven forms that pre-populate claims from structured fields
- DO: All UI copy via `ATTESTATION_LABELS` from `src/lib/copy.ts` — no hardcoded strings
- DO: Use compliant terminology (Network Receipt not transaction, Fingerprint not hash, Network Checkpoint not block)
- DON'T: Use banned terms in any user-visible string (see CLAUDE.md §1.3)
