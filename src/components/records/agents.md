# agents.md — components/records
_Last updated: 2026-05-16_

## What This Folder Contains
Document records list component with virtualized rendering and status-based actions.

## Key Files
- `RecordsList.tsx` — Virtualized list of secured documents showing status (PENDING/BROADCASTING/SUBMITTED/SECURED/REVOKED/EXPIRED), credential type, and per-record action menus (view, download, copy link, revoke)
- `index.ts` — Barrel exports

## Dependencies
- `@tanstack/react-virtual` — virtualized list rendering for performance
- `@/lib/copy` (CREDENTIAL_TYPE_LABELS, RECORDS_LIST_LABELS) — UI strings
- `@/components/ui/ExplorerLink` — network explorer deep links
- `@/lib/urlValidator` (isSafeUrl) — XSS-safe URL validation

## Do / Don't Rules
- DO: Use virtualized rendering for records lists to handle large datasets
- DO NOT: Expose raw `id` or `user_id` — use `public_id` for external-facing links
