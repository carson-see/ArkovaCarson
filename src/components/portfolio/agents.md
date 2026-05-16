# agents.md — components/portfolio
_Last updated: 2026-05-16_

## What This Folder Contains
Credential portfolio creation for shareable collections of attestations and anchored records.

## Key Files
- `CreatePortfolioDialog.tsx` — Dialog for creating a shareable credential portfolio: select attestations/records, set title and expiry
- `index.ts` — Barrel exports

## Dependencies
- `@/hooks/useAuth` — current user context
- `@/lib/supabase` — portfolio CRUD
- `@/lib/routes` (getAppBaseUrl) — shareable portfolio URL generation
