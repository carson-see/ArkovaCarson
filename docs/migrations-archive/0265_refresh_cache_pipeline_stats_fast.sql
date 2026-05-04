-- SCRUM-1256 (R1-2): rewrite refresh_cache_pipeline_stats() so it actually completes.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- The previous version (migration 0242, last touched in 0244) issued one
-- aggregate FILTER over all anchor rows matching `metadata ? 'pipeline_source'`.
-- Once `anchors` got bloated to ~70% dead tuples, even the index-assisted scan
-- ran past the function's 60s timeout, then past pg_cron's 120s wraparound,
-- failing every single invocation since 2026-04-18 18:49 UTC. Each failed run
-- held a 120s snapshot, blocking autovacuum for 6+ days — the death spiral
-- diagnosed in Confluence forensic page 3/8 (27133140).
--
-- HOW THIS FIXES IT
-- -----------------
-- Mirrors the pattern from get_anchor_status_counts_fast(): each per-status
-- count gets its own BEGIN/EXCEPTION block with `SET LOCAL statement_timeout
-- = '1s'`. Sentinel `-1` on timeout — the cache renders "—" instead of zero
-- when a bucket can't be measured this round, and the cron job continues
-- regardless. Each per-status query hits the partial index built out-of-band
-- 2026-04-24 (`idx_anchors_pipeline_status` ON anchors (status, created_at
-- DESC) WHERE deleted_at IS NULL AND metadata ? 'pipeline_source').
--
-- Function-level statement_timeout tightened from 60s → 10s. No individual
-- query inside should exceed its per-statement budget; the function-level
-- value is just a safety net.
--
-- IMPORTANT: each EXCEPTION block must catch `query_canceled` EXPLICITLY.
-- Per PostgreSQL plpgsql docs, `WHEN OTHERS` does NOT catch `QUERY_CANCELED`
-- (SQLSTATE 57014) — that's the SQLSTATE raised by statement_timeout. The
-- first iteration of this migration only had `WHEN OTHERS` and it propagated
-- the cancel up through pg_cron; the cron job kept failing at 120s instead
-- of sentinel-ing out at 1s. Catching `query_canceled` first is the actual
-- timeout escape hatch.
--
-- KNOWN postgres LIMITATION: `SET LOCAL statement_timeout` *inside* a plpgsql
-- function updates the GUC value (verified via `current_setting()`) but does
-- NOT affect the timer for inner SELECTs. PostgreSQL's `enable_statement_timeout()`
-- is called at top-level command entry only — once the OUTER `SELECT
-- refresh_pipeline_dashboard_cache()` starts, the timer is set based on the
-- session GUC at that moment, and inner SET LOCAL changes don't restart it.
--
-- THE TIMEOUT THAT ACTUALLY APPLIES IS THE OUTER pg_cron SESSION'S
-- statement_timeout. That's why the cron command must be:
--
--   SET statement_timeout = '20s'; SELECT refresh_pipeline_dashboard_cache();
--
-- (See cron.schedule call in the VERIFY section above; do NOT just schedule
-- the bare SELECT — the wrapper's BEGIN/EXCEPTION blocks won't fire on time.)
--
-- The function-level / SET LOCAL pattern in this file is therefore best-effort
-- defense-in-depth for FUTURE callers that DO set a tight session timeout
-- before calling the function (e.g. an admin SQL console or a worker route).
-- Under heavy `anchors` bloat (n_dead_tup / n_live_tup > 0.5) even a tight
-- session timeout will sentinel most buckets to -1 — that's by design;
-- frontend renders "—" and the cron tick succeeds. Once autovacuum reclaims
-- the dead pages, all per-status counts complete in milliseconds and real
-- numbers fill in.
--
-- IDEMPOTENT: this is a CREATE OR REPLACE on an existing function.
--
-- ROLLBACK:
--   -- Restore the previous (slow) version. Prefer keeping this version
--   -- and disabling pg_cron jobid 3 instead.
--   CREATE OR REPLACE FUNCTION public.refresh_cache_pipeline_stats() ...
--   (see migration 0242 lines 155-214 for the original body).
--
-- VERIFY AFTER APPLY (post-autovacuum — see operator step below):
--   SET statement_timeout = '20s';
--   SELECT refresh_cache_pipeline_stats();
--   SELECT cache_value FROM pipeline_dashboard_cache WHERE cache_key = 'pipeline_stats';
--   -- Re-enable cron with explicit session timeout in the command:
--   SELECT cron.schedule(
--     'refresh-pipeline-dashboard-cache',
--     '* * * * *',
--     $$SET statement_timeout = '20s'; SELECT refresh_pipeline_dashboard_cache();$$
--   );
--
-- OPERATOR STEP (NOT auto-applied by this migration):
--   This migration replaces the function body but DOES NOT re-enable the
--   cron job. Operator must:
--     1. Wait for the in-flight autovacuum on `anchors` to complete.
--        Verify: SELECT n_dead_tup, n_live_tup FROM pg_stat_user_tables WHERE relname='anchors';
--        Target: n_dead_tup / n_live_tup < 0.05.
--     2. Manually invoke `SELECT refresh_cache_pipeline_stats();` with a
--        session-level `SET statement_timeout = '20s'` and confirm the cache
--        row populates with real values (no sentinel -1 in the JSON).
--     3. Re-enable the cron job with the SET-prefixed command above.
--   Until then, jobid for refresh-pipeline-dashboard-cache MUST stay
--   unscheduled (was jobid 3 originally; jobid 4 reserved by an
--   intermediate re-enable that landed on the failing v1 of this migration
--   and was unscheduled per R1-2 part 1).

CREATE OR REPLACE FUNCTION public.refresh_cache_pipeline_stats()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  SET statement_timeout TO '10s'
AS $function$
DECLARE
  v_total bigint := 0;
  v_unlinked bigint := -1;
  v_linked bigint := 0;
  v_embedded bigint := -1;
  v_pending_anchor bigint := -1;
  v_broadcasting bigint := -1;
  v_submitted bigint := -1;
  v_secured bigint := -1;
  v_bitcoin_anchored bigint := 0;
  v_pending_bitcoin bigint := 0;
BEGIN
  -- Total: instant via pg_class.reltuples (refreshed on ANALYZE).
  SELECT GREATEST(reltuples::bigint, 0) INTO v_total
  FROM pg_class
  WHERE relname = 'public_records' AND relnamespace = 'public'::regnamespace;

  -- Unlinked records (no anchor yet). 1s budget — public_records is healthy
  -- (~2% dead) so this should remain sub-second; sentinel guards regression.
  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT count(*) INTO v_unlinked
    FROM public_records
    WHERE anchor_id IS NULL;
  EXCEPTION
    WHEN query_canceled THEN v_unlinked := -1;
    WHEN OTHERS THEN v_unlinked := -1;
  END;

  IF v_unlinked >= 0 THEN
    v_linked := GREATEST(COALESCE(v_total, 0) - v_unlinked, 0);
  ELSE
    v_linked := -1;
  END IF;

  -- Embedded record count. 1s budget; full table on public_record_embeddings.
  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT count(*) INTO v_embedded
    FROM public_record_embeddings;
  EXCEPTION
    WHEN query_canceled THEN v_embedded := -1;
    WHEN OTHERS THEN v_embedded := -1;
  END;

  -- Per-status pipeline counts. Each query targets idx_anchors_pipeline_status
  -- (status, created_at DESC) WHERE deleted_at IS NULL AND metadata ? 'pipeline_source'.
  -- 1s budget per status; sentinel -1 lets the cron tick succeed even if one
  -- bucket cannot be measured this round.
  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT count(*) INTO v_pending_anchor
    FROM anchors
    WHERE status = 'PENDING'
      AND deleted_at IS NULL
      AND metadata ? 'pipeline_source';
  EXCEPTION
    WHEN query_canceled THEN v_pending_anchor := -1;
    WHEN OTHERS THEN v_pending_anchor := -1;
  END;

  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT count(*) INTO v_broadcasting
    FROM anchors
    WHERE status = 'BROADCASTING'
      AND deleted_at IS NULL
      AND metadata ? 'pipeline_source';
  EXCEPTION
    WHEN query_canceled THEN v_broadcasting := -1;
    WHEN OTHERS THEN v_broadcasting := -1;
  END;

  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT count(*) INTO v_submitted
    FROM anchors
    WHERE status = 'SUBMITTED'
      AND deleted_at IS NULL
      AND chain_tx_id IS NOT NULL
      AND metadata ? 'pipeline_source';
  EXCEPTION
    WHEN query_canceled THEN v_submitted := -1;
    WHEN OTHERS THEN v_submitted := -1;
  END;

  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT count(*) INTO v_secured
    FROM anchors
    WHERE status = 'SECURED'
      AND deleted_at IS NULL
      AND chain_tx_id IS NOT NULL
      AND metadata ? 'pipeline_source';
  EXCEPTION
    WHEN query_canceled THEN v_secured := -1;
    WHEN OTHERS THEN v_secured := -1;
  END;

  -- Aggregates: only sum buckets that actually returned (>=0).
  v_bitcoin_anchored := GREATEST(v_submitted, 0) + GREATEST(v_secured, 0);
  v_pending_bitcoin := GREATEST(v_unlinked, 0)
    + GREATEST(v_pending_anchor, 0)
    + GREATEST(v_broadcasting, 0);

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('pipeline_stats', jsonb_build_object(
    'total_records', COALESCE(v_total, 0),
    'anchor_linked_records', v_linked,
    'pending_record_links', v_unlinked,
    'bitcoin_anchored_records', v_bitcoin_anchored,
    'pending_bitcoin_records', v_pending_bitcoin,
    'pending_anchor_records', v_pending_anchor,
    'broadcasting_records', v_broadcasting,
    'submitted_records', v_submitted,
    'secured_records', v_secured,
    'embedded_records', v_embedded
  ), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$function$;

COMMENT ON FUNCTION public.refresh_cache_pipeline_stats() IS
  'SCRUM-1256 (R1-2) rewrite: per-status counts with 1s budget each + sentinel -1 on timeout. Replaces the single-aggregate FILTER pattern that caused the 2026-04-18..25 death spiral when anchors bloat hit 70%.';
