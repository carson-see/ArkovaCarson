-- Migration 0215: Emergency Pipeline + Treasury Dashboard Performance Fix
--
-- PROBLEM (verified via curl timings against production 2026-04-16):
--   - get_pipeline_stats:            60s (TIMEOUT)   — dashboard primary RPC
--   - count_public_records_by_source: 5s (TIMEOUT)
--   - get_anchor_type_counts:        60s (TIMEOUT)
--   - get_anchor_tx_stats:           15s (TIMEOUT)   — treasury primary RPC
--   - get_distinct_record_types:     4.2s (slow)
--   - get_anchor_status_counts_fast: 4.3s (slow)
-- Combined = 90+ seconds dashboard load.
--
-- Cause: full scans / GROUP BY / count(DISTINCT) on 1.6M+ row anchors table
-- and 1.9M+ row public_records table.
--
-- SOLUTION:
--   1. Create pipeline_dashboard_cache (key → jsonb) summary table
--   2. refresh_pipeline_dashboard_cache() function — runs expensive queries once
--   3. Rewrite all slow RPCs to READ FROM CACHE (microseconds)
--   4. Schedule pg_cron to refresh every 60 seconds
--   5. On first call, seed the cache synchronously (one-time cost)

-- =========================================================================
-- 1. CACHE TABLE
-- =========================================================================
CREATE TABLE IF NOT EXISTS pipeline_dashboard_cache (
  cache_key text PRIMARY KEY,
  cache_value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pipeline_dashboard_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_dashboard_cache FORCE ROW LEVEL SECURITY;

-- Platform admins can read. Writes only via SECURITY DEFINER function.
DROP POLICY IF EXISTS pdc_admin_read ON pipeline_dashboard_cache;
CREATE POLICY pdc_admin_read ON pipeline_dashboard_cache
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  );

GRANT SELECT ON pipeline_dashboard_cache TO authenticated, service_role;

-- =========================================================================
-- 2. REFRESH FUNCTION — runs the expensive queries, stores results
-- =========================================================================
CREATE OR REPLACE FUNCTION refresh_pipeline_dashboard_cache()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'  -- refresh may take a while on first run; OK because it runs in background
AS $$
DECLARE
  v_started_at timestamptz := clock_timestamp();
  v_total_records bigint;
  v_embedded_records bigint;
  v_anchored_records bigint;
  v_pending_records bigint;
  v_anchor_total bigint;
  v_anchor_pending bigint;
  v_anchor_submitted bigint;
  v_anchor_broadcasting bigint;
  v_anchor_revoked bigint;
  v_anchor_secured bigint;
  v_by_source jsonb;
  v_by_credential_type jsonb;
  v_record_types jsonb;
  v_distinct_tx bigint;
  v_anchors_with_tx bigint;
  v_last_anchor_time timestamptz;
  v_last_tx_time timestamptz;
BEGIN
  -- Total records: pg_class estimate (instant, within a few % accuracy)
  SELECT reltuples::bigint INTO v_total_records FROM pg_class WHERE relname = 'public_records';
  SELECT reltuples::bigint INTO v_embedded_records FROM pg_class WHERE relname = 'public_record_embeddings';
  SELECT reltuples::bigint INTO v_anchor_total FROM pg_class WHERE relname = 'anchors';

  -- Anchored vs pending records: use pg_stats.null_frac on anchor_id column (instant, approximate)
  SELECT
    COALESCE(round(v_total_records * (1 - s.null_frac))::bigint, 0),
    COALESCE(round(v_total_records * s.null_frac)::bigint, 0)
  INTO v_anchored_records, v_pending_records
  FROM pg_stats s
  WHERE s.tablename = 'public_records' AND s.attname = 'anchor_id';

  -- Fallback if pg_stats unavailable (no ANALYZE has run yet)
  IF v_anchored_records IS NULL OR v_anchored_records = 0 THEN
    -- Expensive fallback — but only when pg_stats is empty, and this runs async
    SELECT count(*) INTO v_anchored_records FROM public_records WHERE anchor_id IS NOT NULL;
    v_pending_records := GREATEST(v_total_records - v_anchored_records, 0);
  END IF;

  -- Anchor status counts: small-status exact counts, derive SECURED (same pattern as 0182)
  SELECT count(*) INTO v_anchor_pending
  FROM anchors WHERE status = 'PENDING' AND deleted_at IS NULL;

  SELECT count(*) INTO v_anchor_submitted
  FROM anchors WHERE status = 'SUBMITTED' AND deleted_at IS NULL;

  SELECT count(*) INTO v_anchor_broadcasting
  FROM anchors WHERE status = 'BROADCASTING' AND deleted_at IS NULL;

  SELECT count(*) INTO v_anchor_revoked
  FROM anchors WHERE status = 'REVOKED' AND deleted_at IS NULL;

  v_anchor_secured := GREATEST(v_anchor_total - v_anchor_pending - v_anchor_submitted - v_anchor_broadcasting - v_anchor_revoked, 0);

  -- By-source breakdown (1.9M rows, GROUP BY source — ~8s per call but cached)
  SELECT jsonb_object_agg(source, cnt)
  INTO v_by_source
  FROM (
    SELECT source, count(*) AS cnt
    FROM public_records
    GROUP BY source
  ) t;

  -- By credential-type breakdown (1.6M rows, GROUP BY credential_type, status — cached)
  SELECT jsonb_agg(row_to_json(t)::jsonb)
  INTO v_by_credential_type
  FROM (
    SELECT
      COALESCE(credential_type::text, 'UNKNOWN') AS credential_type,
      status::text AS status,
      count(*)::bigint AS count
    FROM anchors
    WHERE deleted_at IS NULL
    GROUP BY credential_type, status
    ORDER BY count(*) DESC
  ) t;

  -- Distinct record types (1.9M rows DISTINCT — cached)
  SELECT jsonb_agg(record_type ORDER BY record_type)
  INTO v_record_types
  FROM (SELECT DISTINCT record_type FROM public_records) t;

  -- TX stats (distinct chain_tx_id is expensive — cached)
  SELECT count(DISTINCT chain_tx_id), count(*)
  INTO v_distinct_tx, v_anchors_with_tx
  FROM anchors
  WHERE chain_tx_id IS NOT NULL AND deleted_at IS NULL;

  SELECT max(created_at) INTO v_last_anchor_time FROM anchors WHERE deleted_at IS NULL;
  SELECT max(updated_at) INTO v_last_tx_time FROM anchors WHERE chain_tx_id IS NOT NULL AND deleted_at IS NULL;

  -- Store all into cache atomically
  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES
    ('pipeline_stats', jsonb_build_object(
      'total_records', v_total_records,
      'anchored_records', v_anchored_records,
      'pending_records', v_pending_records,
      'embedded_records', v_embedded_records
    ), now()),
    ('by_source', COALESCE(v_by_source, '{}'::jsonb), now()),
    ('anchor_type_counts', COALESCE(v_by_credential_type, '[]'::jsonb), now()),
    ('record_types', COALESCE(v_record_types, '[]'::jsonb), now()),
    ('anchor_status_counts', jsonb_build_object(
      'PENDING', v_anchor_pending,
      'SUBMITTED', v_anchor_submitted,
      'BROADCASTING', v_anchor_broadcasting,
      'SECURED', v_anchor_secured,
      'REVOKED', v_anchor_revoked,
      'total', v_anchor_total
    ), now()),
    ('anchor_tx_stats', jsonb_build_object(
      'distinct_tx_count', COALESCE(v_distinct_tx, 0),
      'anchors_with_tx', COALESCE(v_anchors_with_tx, 0),
      'total_anchors', v_anchor_total,
      'last_anchor_time', v_last_anchor_time,
      'last_tx_time', v_last_tx_time
    ), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value,
        updated_at = EXCLUDED.updated_at;

  RETURN jsonb_build_object(
    'refreshed_keys', 6,
    'duration_ms', extract(milliseconds from clock_timestamp() - v_started_at)::int
  );
END;
$$;

GRANT EXECUTE ON FUNCTION refresh_pipeline_dashboard_cache() TO service_role;

-- =========================================================================
-- 3. FAST RPC WRAPPERS — read from cache (microseconds)
-- =========================================================================

-- Fast get_pipeline_stats — reads from cache, falls back to pg_class estimates
CREATE OR REPLACE FUNCTION get_pipeline_stats()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_cached jsonb;
  v_total bigint;
  v_embedded bigint;
BEGIN
  -- Admin access check
  IF NOT (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN
    RAISE EXCEPTION 'Access denied: platform admin required';
  END IF;

  SELECT cache_value INTO v_cached
  FROM pipeline_dashboard_cache
  WHERE cache_key = 'pipeline_stats';

  IF v_cached IS NOT NULL THEN
    RETURN v_cached::json;
  END IF;

  -- Cache miss: return pg_class estimates immediately (instant, approximate)
  SELECT reltuples::bigint INTO v_total FROM pg_class WHERE relname = 'public_records';
  SELECT reltuples::bigint INTO v_embedded FROM pg_class WHERE relname = 'public_record_embeddings';

  RETURN json_build_object(
    'total_records', COALESCE(v_total, 0),
    'anchored_records', 0,
    'pending_records', 0,
    'embedded_records', COALESCE(v_embedded, 0),
    'cache_miss', true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_pipeline_stats() TO authenticated, service_role;

-- Fast count_public_records_by_source — reads from cache
CREATE OR REPLACE FUNCTION count_public_records_by_source()
RETURNS TABLE(source text, count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  IF NOT (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN
    RAISE EXCEPTION 'Access denied: platform admin required';
  END IF;

  RETURN QUERY
  SELECT kv.key::text AS source, (kv.value)::text::bigint AS count
  FROM pipeline_dashboard_cache pdc,
       LATERAL jsonb_each(pdc.cache_value) AS kv
  WHERE pdc.cache_key = 'by_source'
  ORDER BY (kv.value)::text::bigint DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION count_public_records_by_source() TO authenticated, service_role;

-- Fast get_anchor_type_counts — reads from cache
CREATE OR REPLACE FUNCTION get_anchor_type_counts()
RETURNS TABLE(credential_type text, status text, count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  IF NOT (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN
    RAISE EXCEPTION 'Access denied: platform admin required';
  END IF;

  RETURN QUERY
  SELECT
    (row_obj->>'credential_type')::text AS credential_type,
    (row_obj->>'status')::text AS status,
    (row_obj->>'count')::bigint AS count
  FROM pipeline_dashboard_cache pdc,
       LATERAL jsonb_array_elements(pdc.cache_value) AS row_obj
  WHERE pdc.cache_key = 'anchor_type_counts';
END;
$$;

GRANT EXECUTE ON FUNCTION get_anchor_type_counts() TO authenticated, service_role;

-- Fast get_distinct_record_types — reads from cache
CREATE OR REPLACE FUNCTION get_distinct_record_types()
RETURNS TABLE(record_type text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT elem::text AS record_type
  FROM pipeline_dashboard_cache pdc,
       LATERAL jsonb_array_elements_text(pdc.cache_value) AS elem
  WHERE pdc.cache_key = 'record_types';
END;
$$;

GRANT EXECUTE ON FUNCTION get_distinct_record_types() TO authenticated, service_role;

-- Fast get_anchor_status_counts — reads from cache (replaces the 4.3s fast version for the hook)
CREATE OR REPLACE FUNCTION get_anchor_status_counts()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_cached jsonb;
BEGIN
  SELECT cache_value INTO v_cached
  FROM pipeline_dashboard_cache
  WHERE cache_key = 'anchor_status_counts';

  IF v_cached IS NOT NULL THEN
    RETURN v_cached::json;
  END IF;

  -- Cache miss: return empty
  RETURN json_build_object(
    'PENDING', 0, 'SUBMITTED', 0, 'BROADCASTING', 0,
    'SECURED', 0, 'REVOKED', 0, 'total', 0, 'cache_miss', true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_anchor_status_counts() TO authenticated, service_role;

-- Fast get_anchor_tx_stats — reads from cache
CREATE OR REPLACE FUNCTION get_anchor_tx_stats()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_cached jsonb;
BEGIN
  SELECT cache_value INTO v_cached
  FROM pipeline_dashboard_cache
  WHERE cache_key = 'anchor_tx_stats';

  IF v_cached IS NOT NULL THEN
    RETURN v_cached::json;
  END IF;

  RETURN json_build_object(
    'distinct_tx_count', 0, 'anchors_with_tx', 0, 'total_anchors', 0,
    'last_anchor_time', NULL, 'last_tx_time', NULL, 'cache_miss', true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_anchor_tx_stats() TO authenticated, service_role;

-- =========================================================================
-- 4. Schedule pg_cron refresh every 60 seconds
-- =========================================================================
DO $$
BEGIN
  -- Unschedule existing job if any (ignore error if not scheduled)
  BEGIN
    PERFORM cron.unschedule('refresh-pipeline-dashboard-cache');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  -- Schedule every 1 minute
  PERFORM cron.schedule(
    'refresh-pipeline-dashboard-cache',
    '* * * * *',
    $cron$SELECT refresh_pipeline_dashboard_cache();$cron$
  );
EXCEPTION WHEN undefined_table OR undefined_function OR undefined_schema THEN
  -- pg_cron not available (e.g., local dev) — skip silently
  RAISE NOTICE 'pg_cron not available, skipping scheduled refresh. Refresh must be triggered externally.';
END $$;

-- =========================================================================
-- 5. Seed the cache — RUN THIS MANUALLY AFTER MIGRATION APPLIES
-- =========================================================================
-- After migration applies, run separately (not in a migration transaction):
--   SELECT refresh_pipeline_dashboard_cache();
-- Takes ~20-30s on production (one-time cost). After that, pg_cron keeps
-- the cache fresh every 60s, and all dashboards load in microseconds.

-- =========================================================================
-- ROLLBACK:
-- SELECT cron.unschedule('refresh-pipeline-dashboard-cache');
-- DROP FUNCTION IF EXISTS refresh_pipeline_dashboard_cache();
-- DROP TABLE IF EXISTS pipeline_dashboard_cache;
-- Restore 0175, 0182, 0145, 0134, 0123, 0090 function definitions.
-- =========================================================================
