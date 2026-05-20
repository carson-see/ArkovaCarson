# Anchors Index Consolidation Decision
_Last updated: 2026-05-20_

Published page:
https://arkova.atlassian.net/wiki/spaces/A/pages/56852483/SCRUM-1286+Anchors+Index+Consolidation+Decision

Follow-up for deferred trigram drop:
https://arkova.atlassian.net/browse/SCRUM-1976

SCRUM-1976 final decision:
https://arkova.atlassian.net/wiki/spaces/A/pages/57278465/SCRUM-1976+Anchors+Trigram+Search+Decision

## SCRUM-1286 Scope

SCRUM-1286 consolidates redundant or barely-used `public.anchors` indexes after
the R1 vacuum and deferred pipeline index work completed. The confirmed drop set
is documented in `supabase/migrations/0313_anchors_index_consolidation.sql`.

## Confirmed Drops

The following indexes are approved for manual `DROP INDEX CONCURRENTLY` because
they are redundant, dominated by narrower partial indexes, or invalid/no-op
production leftovers:

| Index | Decision | Rationale |
|---|---|---|
| `idx_anchors_status` | Drop | Covered for active-row query shapes by `idx_anchors_status_created`; unfiltered copy adds write cost. |
| `idx_anchors_user_created` | Drop | Duplicated by active-row partial `idx_anchors_user_created_desc`. |
| `idx_anchors_credential_type_btree` | Drop | Low scan count and dominated by partial `idx_anchors_credential_type_status`. |
| `idx_anchors_sub_type` | Drop | Zero-scan, tiny, and not a correctness invariant. |
| `idx_anchors_pipeline_source_id` | Drop if present | Invalid production/index-drift tech debt; absent from the active baseline. |

Keep `anchors_unique_active_child_per_parent` because it enforces lineage
correctness, and keep `idx_anchors_pipeline_status` because the pipeline
dashboard cache depends on it.

## Production Application Evidence

Applied to production project `vzwyaatejekddvltxyye` on 2026-05-20 with each
`DROP INDEX CONCURRENTLY IF EXISTS` run as a standalone statement:

- `public.idx_anchors_status`
- `public.idx_anchors_user_created`
- `public.idx_anchors_credential_type_btree`
- `public.idx_anchors_sub_type`
- `public.idx_anchors_pipeline_source_id`

The production migration ledger is recorded as:

| Version | Name | Created by |
|---|---|---|
| `0313` | `anchors_index_consolidation` | `codex-scrum-1286` |

Post-drop verification:

- The five dropped indexes no longer appear in `pg_stat_user_indexes` for
  `public.anchors`.
- `public.anchors` index count changed from 35 to 30.
- `public.anchors` total index size changed from 7699 MB to 7386 MB, an
  observed reclaim of about 313 MB after the earlier R1 vacuum. This is lower
  than the original pre-vacuum estimate because the AC estimate was captured
  before vacuum/index shrinkage.
- The two trigram GINs remain: `idx_anchors_filename_trgm` at 2726 MB and
  `idx_anchors_description_trgm` at 1091 MB.

Representative post-drop plan checks:

- User/fingerprint lookup still uses `idx_anchors_fingerprint_lookup`.
- Pending status lookup moved from `idx_anchors_status` to
  `idx_anchors_status_created`.
- Secured chain lookup still uses `idx_anchors_secured_chain_ts`.
- Secured revocation lookup remains a sequential scan, unchanged by the drop.

## Trigram GIN Decision

Decision: keep `idx_anchors_filename_trgm` and
`idx_anchors_description_trgm`.

Reason: the pre-drop code search found live non-test substring search paths over
`anchors.filename` and `anchors.description`:

- `search_public_credentials(p_query, p_limit)` uses `a.filename ILIKE v_pattern`
  and `a.description ILIKE v_pattern` with a 5 second statement timeout.
- `src/pages/SearchPage.tsx` falls back to an `anchors.filename ILIKE '%query%'`
  query when the public search RPC fails.
- `services/worker/src/api/v2/search.ts` searches records/documents with
  `filename.ilike.%query%` and `description.ilike.%query%`.
- Archived migrations `0150`, `0157`, and `0183` state that the trigram indexes
  were added to prevent full scans and timeouts on large `anchors` searches.

Production `idx_scan` counts were low enough to make the GINs strong reclaim
candidates, but SCRUM-1976 production `EXPLAIN (ANALYZE, BUFFERS)` proved the
public and v2 filename/description search shapes use both trigram indexes. The
3.1 GB stretch drop is therefore not approved.

## Required Verification

Before applying `0313`, capture:

```sql
select
  indexrelname,
  pg_size_pretty(pg_relation_size(indexrelid)) as size,
  idx_scan
from pg_stat_user_indexes
where schemaname = 'public'
  and relname = 'anchors'
  and indexrelname in (
    'idx_anchors_status',
    'idx_anchors_user_created',
    'idx_anchors_credential_type_btree',
    'idx_anchors_sub_type',
    'idx_anchors_pipeline_source_id'
  )
order by indexrelname;
```

After applying `0313`, rerun the top `anchors` query EXPLAIN baselines and
confirm no search, pipeline, status, or credential-type regression before moving
SCRUM-1286 to Done. This was completed on 2026-05-20; see Production Application
Evidence above and SCRUM-1976's final search decision doc.
