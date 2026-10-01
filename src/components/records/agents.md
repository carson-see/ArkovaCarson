# agents.md — components/records
_Last updated: 2026-09-29_

## 2026-09-29 — `RecordsList.tsx` connector-record card readability (founder-reported dashboard follow-up)

Founder, looking at `/dashboard`: every Google Drive record card titled itself with the raw
internal id (`google_drive:1IxoL...`) and dumped all ten raw connector metadata keys (file id,
mime type, revision id, content type, external ref, rule event id, integration id, connector
source, export mime type, connector artifact id) — `HIDDEN_META_KEYS` was allow-everything
except a handful of unrelated keys, so none of the connector fields were ever denied.

- `buildRecordTitle`'s final fallback is now `deriveDisplayTitle(record.filename, meta)`
  (`src/lib/recordDisplay.ts` — the SAME helper the Record Detail page uses; not reimplemented
  here, per the SonarCloud new-code duplication budget). The entity-name-derived title paths
  (SEC/EDGAR-style, issuer/recipient-style) are unchanged and still take precedence when present.
- `HIDDEN_META_KEYS` now spreads in `CONNECTOR_INTERNAL_METADATA_KEYS` — the single shared
  denylist in `recordDisplay.ts` — so a connector record's card never renders any of the ten
  raw identifiers. `fraud_*` filtering (BUG-2026-07-17-010) is unaffected and still covered by
  its own regression test.
- A connector-sourced card (`metadata.connector_source` recognised by
  `deriveConnectorSourceLabel`) shows a truthful MIME-derived type badge
  (`deriveDisplayType(metadata.mime_type ?? metadata.content_type, metadata)`) in place of the
  credential-type badge, plus a small "Google Drive"/"DocuSign" source label
  (`data-testid="record-source-label"`) — the credential type on a connector record is typically
  the extraction/connector default, not anything a human chose.
- New `record-version-chip` (`versionNumber > 1`) and `record-superseded-chip`
  (`status === 'SUPERSEDED'`) badges — added to `Record`'s type as `versionNumber`/
  `parentAnchorId` (populated by `useAnchors.ts` / `usePrivateAnchorList.ts`, see
  `src/hooks/agents.md`). **Every version of a document remains its own visible card, newest
  first via the existing `created_at desc` ordering — a superseded card is marked, never
  hidden** (supersede is never revoke). No new filtering was added to exclude SUPERSEDED rows;
  this was already the case before this change (no status filter excluded them) and is now
  visually explicit via the chip.

Tests: `RecordsList.connector-readability.test.tsx` (new, 7 cases, TDD red-first — the "no raw
key leaks" and title-derivation cases were confirmed RED against the pre-fix component).
Existing `RecordsList.test.tsx` (4 cases, Network-Observed-Time + fraud-filter regressions)
passes unchanged.

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
