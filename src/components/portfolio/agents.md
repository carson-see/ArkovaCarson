# agents.md — components/portfolio
_Last updated: 2026-07-21_

## What This Folder Contains
Credential portfolio creation for shareable collections of attestations and anchored records.

## Key Files
- `CreatePortfolioDialog.tsx` — Dialog for creating a shareable credential portfolio: select attestations/records, set title and expiry
- `index.ts` — Barrel exports

## Dependencies
- `@/hooks/useAuth` — current user context
- `@/lib/supabase` — portfolio CRUD
- `@/lib/routes` (getAppBaseUrl) — shareable portfolio URL generation

## 2026-07-21 SCRUM-2938 S2 — terminology scrub remainder

CreatePortfolioDialog title scrubbed ("Create Record Portfolio"). Internal identifiers (keys, enum values, `credential_type`, API params) are unchanged per §1.3 "internal code may use technical names". Contract test: `src/lib/copy-scrum-2938-terminology-s2.test.ts` (walks every copy.ts string value; SCRUM-1672 `ISSUE_CREDENTIAL_LABELS` carve-out locked byte-identical).
