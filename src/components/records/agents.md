# agents.md — components/records
_Last updated: 2026-07-27_

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
- DO NOT (§1.5): Render `createdAt` under the "Network Observed Time" label. The
  network has only "observed" a record once it is SECURED (`securedAt` set). For
  unconfirmed records, show `RECORDS_LIST_LABELS.CREATED_TIME` ("Record Created")
  with the local creation time — never the local time under the network label.

## Recent Changes
- 2026-07-27 SCRUM-2940 (Folders UI): `RecordsList.tsx`'s shared `Record`
  interface gained `folderId?: string | null` (populated by `useAnchors`).
  `RecordsList.tsx` itself renders no folder UI — MyRecordsPage renders its
  own record rows and owns the folder filter/actions; see
  `src/components/folders/agents.md`. If `RecordsList` (used by
  `DashboardPage`) grows folder actions later, wire through the same
  `folderId` field rather than adding a second shape.
- 2026-07-17 SCRUM-2910 (BUG-2026-07-17-010, P0): `RecordsList.tsx` row metadata filter also hides any `fraud*` key via `isFraudMetadataKey` from `@/lib/fraudDetection`.
- 2026-06-24 BUG-2026-06-24-008: `RecordsList.tsx` "Network Observed Time" field
  now renders the network label only when `securedAt` is set; otherwise it shows
  an honest "Record Created" label. Regression test: `RecordsList.test.tsx`.
