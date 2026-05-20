# SCRUM-1976 Anchors Trigram Search Decision
_Last updated: 2026-05-20_

Published page:
https://arkova.atlassian.net/wiki/spaces/A/pages/57278465/SCRUM-1976+Anchors+Trigram+Search+Decision

Related:
- https://arkova.atlassian.net/browse/SCRUM-1976
- https://arkova.atlassian.net/browse/SCRUM-1286
- https://arkova.atlassian.net/wiki/spaces/A/pages/56852483/SCRUM-1286+Anchors+Index+Consolidation+Decision

## Decision

Keep `idx_anchors_filename_trgm` and `idx_anchors_description_trgm`.

Do not add a trigram drop migration. Public and API v2 text discovery remains a
product/API requirement, and production `EXPLAIN (ANALYZE, BUFFERS)` shows the
live filename/description search shapes use both trigram GIN indexes.

## Production Evidence

Captured against production project `vzwyaatejekddvltxyye` on 2026-05-20 using
the Supabase Management API read-only query endpoint.

| Query shape | Evidence | Decision impact |
|---|---|---|
| Public `search_public_credentials` expanded SQL for `%arkova%` | `BitmapOr` with `Bitmap Index Scan on idx_anchors_filename_trgm` and `Bitmap Index Scan on idx_anchors_description_trgm`; execution time 5717.403 ms; buffers hit=731 read=222. | Dropping either trigram would put a public RPC with a 5s statement timeout back at full-scan risk. |
| SearchPage filename fallback for `%arkova%` | `Bitmap Index Scan on idx_anchors_filename_trgm`; execution time 5.956 ms; buffers hit=748. | Frontend fallback still depends on filename trigram acceleration when the RPC fails. |
| API v2 record text search, filename/description branches | `BitmapOr` with both trigram indexes; execution time 15544.101 ms on a cold read; buffers hit=108 read=824. | Text record discovery depends on both trigrams. |
| API v2 document text search, filename/description branches | `BitmapOr` with both trigram indexes; execution time 9.907 ms after cache warmup; buffers hit=932. | Text document discovery depends on both trigrams. |
| API v2 old record fingerprint substring branch | Timed out at 30s when `fingerprint ILIKE '%arkova%'` was included with filename/description. | PR changes record search to use exact fingerprint equality only for SHA-256 queries. |
| API v2 old metadata substring branches | Timed out at 30s when `metadata->>'issuer'`, `recipient`, and `title` ILIKE branches were included. | PR removes those unindexed metadata substring branches from the document alias. |

Index stats immediately after the SCRUM-1286 confirmed drops:

| Index | Size | `idx_scan` | Status |
|---|---:|---:|---|
| `idx_anchors_filename_trgm` | 2726 MB | 25 | Keep |
| `idx_anchors_description_trgm` | 1091 MB | 20 | Keep |

## Log Baseline

Last-24h Supabase log checks on 2026-05-20:

- Postgres errors filtered to `search_public_credentials`: 0 rows.
- Edge/PostgREST traffic filtered to `/rest/v1/rpc/search_public_credentials`: 0 rows.
- The broader Postgres timeout sweep did show unrelated 57014 timeouts in
  `get_unembedded_public_records`, `batch_insert_anchors`, `claim_pending_anchors`,
  and chain/status queries; those are not caused by the trigram search indexes
  and should stay outside SCRUM-1976.

## Code Outcome

This PR keeps public/v2 text discovery semantics but tightens the v2 query
surface so it aligns with indexed production paths:

- Record search keeps `filename ILIKE` and `description ILIKE`.
- Record search uses exact `fingerprint.eq.<sha256>` only when the query is a
  SHA-256 fingerprint.
- Document search keeps `filename ILIKE` and `description ILIKE`.
- Document search no longer emits unindexed `metadata->>` substring branches.

Regression coverage:

- `services/worker/src/api/v2/search.test.ts` asserts record text search does
  not include `fingerprint.ilike`.
- `services/worker/src/api/v2/search.test.ts` asserts SHA-256 record queries use
  exact `fingerprint.eq`.
- `services/worker/src/api/v2/search.test.ts` asserts document search stays on
  filename/description and does not include `metadata->>` branches.

## Acceptance Criteria Mapping

| AC | Result |
|---|---|
| Top public/v2 search query plans captured with `EXPLAIN (ANALYZE, BUFFERS)` | Done; see Production Evidence. |
| Search timeout/error baseline checked in Sentry/PostgREST logs | Done via Supabase Postgres and Edge/PostgREST logs for the last 24h. |
| Drop/keep decision for both trigram GINs documented | Done: keep both. |
| If drop approved, follow-up migration uses standalone `DROP INDEX CONCURRENTLY IF EXISTS public.<index>` statements | Not applicable because drop is not approved. |
