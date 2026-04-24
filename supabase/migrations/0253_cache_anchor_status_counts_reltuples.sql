-- Migration 0253: Fix refresh_cache_anchor_status_counts timeout.
--
-- PROBLEM (evidence from cron.job_run_details, verified 2026-04-24 18:53 UTC):
--   - pg_cron job "refresh-pipeline-dashboard-cache" has been failing every
--     single run since 2026-04-19 18:51:58 UTC — 5 days.
--   - Error: `canceling statement due to statement timeout` (60s) on
--     SELECT count(*) FROM anchors WHERE status = 'PENDING' AND deleted_at IS NULL
--     (and the identical SUBMITTED query on line 8 of the function).
--   - PENDING row count grew from ~62k on 4/19 to ~397k today. count(*) on a
--     partial index still has to walk every matching entry + heap visibility
--     check each tuple; at 397k rows under concurrent write load from the
--     public_record_anchoring job, 60s is no longer enough.
--   - Because the master refresh's BEGIN/EXCEPTION block aborts on the FIRST
--     failing step, no subsequent key (by_source, type_counts, record_types,
--     anchor_tx_stats) ever ran for 5 days. Treasury's "Last Activity" and
--     pipeline dashboards all froze at 4/19 cache state.
--
-- FIX:
--   Use the same reltuples-from-partial-index pattern that
--   refresh_cache_anchor_tx_stats() already uses successfully. Approximate,
--   O(1), immune to table size growth.
--
--   - v_pending    ← reltuples of idx_anchors_pending_claim (WHERE status=PENDING AND deleted_at IS NULL)
--   - v_submitted  ← reltuples of idx_anchors_submitted_chain_tx (WHERE status=SUBMITTED AND deleted_at IS NULL)
--   - v_total      ← reltuples of anchors table
--   - v_secured    ← derived: total - pending - submitted - broadcasting - revoked
--   - BROADCASTING and REVOKED keep count(*) because they're always tiny
--     (transient mid-broadcast rows + admin revocations; count is fast).
--
-- FRESHNESS:
--   pg_class.reltuples is updated by autovacuum/ANALYZE, not per-write. Values
--   can lag real state by minutes on a write-heavy table. The cache is
--   already labeled with updated_at so consumers know when it was built; an
--   additional jsonb field 'status_counts_approximate: true' mirrors the
--   existing 'distinct_tx_approximate' signal on anchor_tx_stats so dashboards
--   can disclose the precision without another migration.
--
-- ROLLBACK:
--   To revert to the prior count(*)-based behavior, restore the function body
--   from migration 0215 lines 94-115. Do this only after validating that the
--   anchors table is small enough (< 50k PENDING) that count(*) completes
--   within 5s — otherwise the cron will freeze again.

CREATE OR REPLACE FUNCTION refresh_cache_anchor_status_counts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '5s'
AS $FN$
DECLARE
  v_total bigint;
  v_pending bigint;
  v_submitted bigint;
  v_broadcasting bigint;
  v_revoked bigint;
  v_secured bigint;
BEGIN
  SELECT reltuples::bigint INTO v_total FROM pg_class WHERE relname = 'anchors';
  SELECT reltuples::bigint INTO v_pending FROM pg_class WHERE relname = 'idx_anchors_pending_claim';
  SELECT reltuples::bigint INTO v_submitted FROM pg_class WHERE relname = 'idx_anchors_submitted_chain_tx';

  -- Small-cardinality statuses: real count(*) completes inside the 5s budget.
  -- BROADCASTING is transient (< seconds between PENDING → SUBMITTED) so
  -- typically 0. REVOKED is admin-only, historically < 10 rows.
  SELECT count(*) INTO v_broadcasting FROM anchors WHERE status = 'BROADCASTING' AND deleted_at IS NULL;
  SELECT count(*) INTO v_revoked FROM anchors WHERE status = 'REVOKED' AND deleted_at IS NULL;

  v_secured := GREATEST(
    COALESCE(v_total, 0)
      - COALESCE(v_pending, 0)
      - COALESCE(v_submitted, 0)
      - COALESCE(v_broadcasting, 0)
      - COALESCE(v_revoked, 0),
    0
  );

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('anchor_status_counts', jsonb_build_object(
    'PENDING', COALESCE(v_pending, 0),
    'SUBMITTED', COALESCE(v_submitted, 0),
    'BROADCASTING', COALESCE(v_broadcasting, 0),
    'SECURED', v_secured,
    'REVOKED', COALESCE(v_revoked, 0),
    'total', COALESCE(v_total, 0),
    'status_counts_approximate', true
  ), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value,
        updated_at = EXCLUDED.updated_at;
END;
$FN$;

GRANT EXECUTE ON FUNCTION refresh_cache_anchor_status_counts() TO service_role;

-- Nudge PostgREST to reload the schema cache so subsequent RPC calls see the
-- new function definition immediately (CLAUDE.md §6 "Common Mistakes").
NOTIFY pgrst, 'reload schema';
