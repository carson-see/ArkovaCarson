# agents.md — components/verify
_Last updated: 2026-05-16_

## What This Folder Contains
Document verification form for checking whether a document has been secured on Arkova.

## Key Files
- `VerificationForm.tsx` — Verify a document by file upload (re-fingerprints client-side) or by entering a fingerprint directly; queries Supabase for match
- `index.ts` — Barrel exports

## Dependencies
- `@/lib/supabase` — verification queries against anchors table

## Do / Don't Rules
- DO: Fingerprint generation runs client-side only — the file never leaves the browser
- DO: Support both file-based and fingerprint-based verification methods
