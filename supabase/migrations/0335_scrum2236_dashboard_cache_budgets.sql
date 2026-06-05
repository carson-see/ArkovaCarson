-- SCRUM-2236 (HARDEN-1) — budget the four unhardened dashboard cache refreshers.
--
-- refresh_pipeline_dashboard_cache() averaged ~55s over 22,686 cron calls
-- (cron runs every 2 min) and was throwing recurring prod statement-timeout
-- ERRORs. Two siblings (refresh_cache_pipeline_stats / refresh_cache_anchor_tx_stats)
-- were already hardened under SCRUM-1256 with the budget+estimate+sentinel pattern.
-- The remaining four sub-refreshers still ran unbudgeted full scans on the ~3M-row
-- anchors / public_records tables under a single coarse 60s statement_timeout:
--
--   refresh_cache_anchor_status_counts  -- per-status count(*) on anchors
--   refresh_cache_anchor_type_counts    -- GROUP BY credential_type,status on anchors
--   refresh_cache_by_source             -- GROUP BY source on public_records
--   refresh_cache_record_types          -- DISTINCT record_type on public_records
--
-- This migration applies the SCRUM-1256 template to all four:
--   * A tight per-statement `SET LOCAL statement_timeout = '1s'` around each scan.
--   * An explicit `EXCEPTION WHEN query_canceled` (SQLSTATE 57014) handler. This is
--     mandatory — `WHEN OTHERS` does NOT catch QUERY_CANCELED, so a budget hit
--     would otherwise propagate out of the sub-refresher and (because the wrapper's
--     per-sub `WHEN OTHERS` also does not catch 57014) abort the entire
--     refresh_pipeline_dashboard_cache() transaction. By catching 57014 inside the
--     sub-refresher we degrade gracefully: write a sentinel / stale marker for the
--     one slow key and let the other keys refresh.
--   * `pg_class.reltuples` for the cheap whole-table estimate where exactness is
--     not required (total anchors). Exact per-status / per-source / per-type counts
--     stay exact but are now individually budgeted and fall back to a sentinel.
--
-- On a budget hit each refresher still writes its cache row, but tagged so callers
-- can tell the value is degraded:
--   * anchor_status_counts: -1 sentinel for the timed-out bucket(s) (matches the
--     existing -1 convention that get_anchor_status_counts_fast already renders "—").
--   * anchor_type_counts / by_source / record_types: the prior value is preserved
--     if present, and the row is marked `{ "stale": true, "stale_reason": "budget" }`
--     via a wrapper object — never replaced with an empty/zero result that would
--     wipe a previously-good cache value.
--
-- Signatures, owners, grants, cache keys, and the success-path JSON shapes are
-- unchanged. SECURITY DEFINER + `SET search_path = public` preserved on all four.
--
-- ROLLBACK:
--   Restore the four baseline bodies (the unbudgeted 60s-timeout full-scan path)
--   from 00000000000000_baseline_at_main_HEAD.sql exactly as below, then
--   NOTIFY pgrst, 'reload schema';
--
--   -- refresh_cache_anchor_status_counts (baseline):
--   --   SET statement_timeout '60s'; SELECT reltuples INTO v_total FROM pg_class
--   --   WHERE relname='anchors'; four bare `SELECT count(*) ... FROM anchors WHERE
--   --   status=... AND deleted_at IS NULL`; v_secured := GREATEST(total - others, 0);
--   --   INSERT ... ON CONFLICT DO UPDATE.
--   -- refresh_cache_anchor_type_counts (baseline):
--   --   SET statement_timeout '60s'; SELECT jsonb_agg(row_to_json(t)) INTO v_result
--   --   FROM (SELECT COALESCE(credential_type::text,'UNKNOWN'), status::text, count(*)
--   --   FROM anchors WHERE deleted_at IS NULL GROUP BY credential_type,status
--   --   ORDER BY count(*) DESC) t; INSERT COALESCE(v_result,'[]') ON CONFLICT.
--   -- refresh_cache_by_source (baseline):
--   --   SET statement_timeout '60s'; SELECT jsonb_object_agg(source,cnt) INTO
--   --   v_by_source FROM (SELECT source, count(*) cnt FROM public_records GROUP BY
--   --   source) t; INSERT COALESCE(v_by_source,'{}') ON CONFLICT.
--   -- refresh_cache_record_types (baseline):
--   --   SET statement_timeout '60s'; SELECT jsonb_agg(record_type ORDER BY
--   --   record_type) INTO v_result FROM (SELECT DISTINCT record_type FROM
--   --   public_records) t; INSERT COALESCE(v_result,'[]') ON CONFLICT.

-- ---------------------------------------------------------------------------
-- 1. refresh_cache_anchor_status_counts — per-status count(*) gets a 1s budget
--    + 57014 sentinel (-1). Total stays a pg_class.reltuples estimate (instant).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."refresh_cache_anchor_status_counts"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '10s'
    AS $$
DECLARE
  v_total bigint := 0;
  v_pending bigint := -1;
  v_submitted bigint := -1;
  v_broadcasting bigint := -1;
  v_revoked bigint := -1;
  v_secured bigint := -1;
BEGIN
  -- Whole-table total: cheap planner estimate, no scan.
  SELECT GREATEST(reltuples::bigint, 0) INTO v_total
  FROM pg_class
  WHERE relname = 'anchors' AND relnamespace = 'public'::regnamespace;

  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT count(*) INTO v_pending FROM anchors WHERE status = 'PENDING' AND deleted_at IS NULL;
  EXCEPTION
    WHEN query_canceled THEN v_pending := -1;
    WHEN OTHERS THEN v_pending := -1;
  END;

  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT count(*) INTO v_submitted FROM anchors WHERE status = 'SUBMITTED' AND deleted_at IS NULL;
  EXCEPTION
    WHEN query_canceled THEN v_submitted := -1;
    WHEN OTHERS THEN v_submitted := -1;
  END;

  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT count(*) INTO v_broadcasting FROM anchors WHERE status = 'BROADCASTING' AND deleted_at IS NULL;
  EXCEPTION
    WHEN query_canceled THEN v_broadcasting := -1;
    WHEN OTHERS THEN v_broadcasting := -1;
  END;

  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT count(*) INTO v_revoked FROM anchors WHERE status = 'REVOKED' AND deleted_at IS NULL;
  EXCEPTION
    WHEN query_canceled THEN v_revoked := -1;
    WHEN OTHERS THEN v_revoked := -1;
  END;

  -- Derive SECURED from the estimate minus the known buckets only when every
  -- bucket counted cleanly; otherwise emit the -1 sentinel (callers render "—").
  IF v_pending >= 0 AND v_submitted >= 0 AND v_broadcasting >= 0 AND v_revoked >= 0 THEN
    v_secured := GREATEST(v_total - v_pending - v_submitted - v_broadcasting - v_revoked, 0);
  ELSE
    v_secured := -1;
  END IF;

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('anchor_status_counts', jsonb_build_object(
    'PENDING', v_pending, 'SUBMITTED', v_submitted,
    'BROADCASTING', v_broadcasting, 'SECURED', v_secured,
    'REVOKED', v_revoked, 'total', v_total
  ), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$$;

ALTER FUNCTION "public"."refresh_cache_anchor_status_counts"() OWNER TO "postgres";

COMMENT ON FUNCTION "public"."refresh_cache_anchor_status_counts"() IS 'SCRUM-2236 (HARDEN-1): per-status count(*) on anchors now individually budgeted (SET LOCAL statement_timeout 1s) with an explicit EXCEPTION WHEN query_canceled (SQLSTATE 57014) sentinel (-1). Total is a pg_class.reltuples estimate. WHEN query_canceled is mandatory — WHEN OTHERS does not catch QUERY_CANCELED. Replaces the baseline 60s unbudgeted scan that drove the recurring dashboard-cache statement-timeout ERRORs.';

-- ---------------------------------------------------------------------------
-- 2. refresh_cache_anchor_type_counts — budgeted GROUP BY on anchors.
--    On a budget hit, preserve the prior value and mark it stale rather than
--    overwriting with an empty result.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."refresh_cache_anchor_type_counts"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '10s'
    AS $$
DECLARE
  v_result jsonb;
  v_timed_out boolean := false;
BEGIN
  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT jsonb_agg(row_to_json(t)::jsonb) INTO v_result
    FROM (
      SELECT COALESCE(credential_type::text, 'UNKNOWN') AS credential_type,
             status::text AS status, count(*)::bigint AS count
      FROM anchors WHERE deleted_at IS NULL
      GROUP BY credential_type, status ORDER BY count(*) DESC
    ) t;
  EXCEPTION
    WHEN query_canceled THEN v_timed_out := true;
    WHEN OTHERS THEN v_timed_out := true;
  END;

  IF v_timed_out THEN
    -- Do not wipe a previously-good value; tag the existing row stale. If no
    -- prior row exists, write an empty stale marker.
    INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
    VALUES ('anchor_type_counts',
            jsonb_build_object('stale', true, 'stale_reason', 'budget', 'value', '[]'::jsonb),
            now())
    ON CONFLICT (cache_key) DO UPDATE
      SET cache_value = jsonb_build_object(
            'stale', true, 'stale_reason', 'budget',
            'value', COALESCE(pipeline_dashboard_cache.cache_value -> 'value',
                              pipeline_dashboard_cache.cache_value)),
          updated_at = EXCLUDED.updated_at;
    RETURN;
  END IF;

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('anchor_type_counts', COALESCE(v_result, '[]'::jsonb), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$$;

ALTER FUNCTION "public"."refresh_cache_anchor_type_counts"() OWNER TO "postgres";

COMMENT ON FUNCTION "public"."refresh_cache_anchor_type_counts"() IS 'SCRUM-2236 (HARDEN-1): GROUP BY credential_type,status on anchors now budgeted (SET LOCAL statement_timeout 1s) with EXCEPTION WHEN query_canceled (57014). On a budget hit the prior cache value is preserved and tagged {stale:true,stale_reason:budget} rather than overwritten with an empty result. WHEN query_canceled is mandatory — WHEN OTHERS does not catch QUERY_CANCELED.';

-- ---------------------------------------------------------------------------
-- 3. refresh_cache_by_source — budgeted GROUP BY source on public_records.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."refresh_cache_by_source"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '10s'
    AS $$
DECLARE
  v_by_source jsonb;
  v_timed_out boolean := false;
BEGIN
  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT jsonb_object_agg(source, cnt) INTO v_by_source
    FROM (SELECT source, count(*) AS cnt FROM public_records GROUP BY source) t;
  EXCEPTION
    WHEN query_canceled THEN v_timed_out := true;
    WHEN OTHERS THEN v_timed_out := true;
  END;

  IF v_timed_out THEN
    INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
    VALUES ('by_source',
            jsonb_build_object('stale', true, 'stale_reason', 'budget', 'value', '{}'::jsonb),
            now())
    ON CONFLICT (cache_key) DO UPDATE
      SET cache_value = jsonb_build_object(
            'stale', true, 'stale_reason', 'budget',
            'value', COALESCE(pipeline_dashboard_cache.cache_value -> 'value',
                              pipeline_dashboard_cache.cache_value)),
          updated_at = EXCLUDED.updated_at;
    RETURN;
  END IF;

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('by_source', COALESCE(v_by_source, '{}'::jsonb), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$$;

ALTER FUNCTION "public"."refresh_cache_by_source"() OWNER TO "postgres";

COMMENT ON FUNCTION "public"."refresh_cache_by_source"() IS 'SCRUM-2236 (HARDEN-1): GROUP BY source on public_records now budgeted (SET LOCAL statement_timeout 1s) with EXCEPTION WHEN query_canceled (57014). On a budget hit the prior cache value is preserved and tagged stale rather than overwritten with {}. WHEN query_canceled is mandatory — WHEN OTHERS does not catch QUERY_CANCELED.';

-- ---------------------------------------------------------------------------
-- 4. refresh_cache_record_types — budgeted DISTINCT record_type on public_records.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."refresh_cache_record_types"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '10s'
    AS $$
DECLARE
  v_result jsonb;
  v_timed_out boolean := false;
BEGIN
  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT jsonb_agg(record_type ORDER BY record_type) INTO v_result
    FROM (SELECT DISTINCT record_type FROM public_records) t;
  EXCEPTION
    WHEN query_canceled THEN v_timed_out := true;
    WHEN OTHERS THEN v_timed_out := true;
  END;

  IF v_timed_out THEN
    INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
    VALUES ('record_types',
            jsonb_build_object('stale', true, 'stale_reason', 'budget', 'value', '[]'::jsonb),
            now())
    ON CONFLICT (cache_key) DO UPDATE
      SET cache_value = jsonb_build_object(
            'stale', true, 'stale_reason', 'budget',
            'value', COALESCE(pipeline_dashboard_cache.cache_value -> 'value',
                              pipeline_dashboard_cache.cache_value)),
          updated_at = EXCLUDED.updated_at;
    RETURN;
  END IF;

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('record_types', COALESCE(v_result, '[]'::jsonb), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$$;

ALTER FUNCTION "public"."refresh_cache_record_types"() OWNER TO "postgres";

COMMENT ON FUNCTION "public"."refresh_cache_record_types"() IS 'SCRUM-2236 (HARDEN-1): DISTINCT record_type on public_records now budgeted (SET LOCAL statement_timeout 1s) with EXCEPTION WHEN query_canceled (57014). On a budget hit the prior cache value is preserved and tagged stale rather than overwritten with []. WHEN query_canceled is mandatory — WHEN OTHERS does not catch QUERY_CANCELED.';

NOTIFY pgrst, 'reload schema';
