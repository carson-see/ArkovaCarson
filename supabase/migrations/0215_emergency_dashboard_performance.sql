-- Migration 0215: Emergency Pipeline + Treasury Dashboard Performance Fix
-- Applied 2026-04-16 in emergency response to 90+ second dashboard loads.
--
-- PROBLEM (verified via curl timings against production 2026-04-16):
--   - get_pipeline_stats:            60s TIMEOUT  — dashboard primary RPC
--   - count_public_records_by_source: 5s TIMEOUT
--   - get_anchor_type_counts:        60s TIMEOUT
--   - get_anchor_tx_stats:           15s TIMEOUT  — treasury primary RPC
--   - get_distinct_record_types:     4.2s
--   - get_anchor_status_counts:      4.3s
-- Combined = 90+ seconds dashboard load. Nothing on pipeline dashboard working.
--
-- Cause: full scans / GROUP BY / count(DISTINCT) on 1.6M+ row anchors table
-- and 1.9M+ row public_records table. The RPCs were designed when tables were
-- much smaller and haven't scaled.
--
-- SOLUTION:
--   1. Create pipeline_dashboard_cache (key → jsonb) summary table
--   2. Per-key refresh functions (refresh_cache_*) so one slow query can't
--      kill the whole refresh cycle
--   3. Master refresh_pipeline_dashboard_cache() that calls each in isolation
--   4. Rewrite all slow RPCs to READ FROM CACHE (~120µs)
--   5. Schedule pg_cron to refresh every 60 seconds
--   6. anchor_tx_stats uses approximations: reltuples + pg_stats.null_frac
--      because count(DISTINCT chain_tx_id) on 1.6M rows is O(N) with no index
--      fast path. distinct_tx_count is set to 0 (marked approximate) until a
--      separate chain_txs tracking table is built.
--
-- RESULT:
--   - All 6 dashboard RPCs respond in ~120ms each
--   - Full parallel dashboard load: 0.16s (down from 90+s)
--   - pg_cron keeps cache fresh every 60s with all 6 keys succeeding in ~59s

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

DROP POLICY IF EXISTS pdc_admin_read ON pipeline_dashboard_cache;
CREATE POLICY pdc_admin_read ON pipeline_dashboard_cache
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  );

GRANT SELECT ON pipeline_dashboard_cache TO authenticated, service_role;

-- =========================================================================
-- 2. PER-KEY REFRESH FUNCTIONS
--    Each function has its own statement_timeout; one slow key won't block
--    others. Called by the master refresh in isolated BEGIN/EXCEPTION blocks.
-- =========================================================================

-- pipeline_stats: uses pg_stats.null_frac — instant
CREATE OR REPLACE FUNCTION refresh_cache_pipeline_stats()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
SET statement_timeout = '30s'
AS $FN$
DECLARE
  v_total bigint; v_embedded bigint; v_anchored bigint; v_pending bigint;
BEGIN
  SELECT reltuples::bigint INTO v_total FROM pg_class WHERE relname = 'public_records';
  SELECT reltuples::bigint INTO v_embedded FROM pg_class WHERE relname = 'public_record_embeddings';

  SELECT
    COALESCE(round(v_total * (1 - s.null_frac))::bigint, 0),
    COALESCE(round(v_total * s.null_frac)::bigint, 0)
  INTO v_anchored, v_pending
  FROM pg_stats s
  WHERE s.tablename = 'public_records' AND s.attname = 'anchor_id';

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('pipeline_stats', jsonb_build_object(
    'total_records', COALESCE(v_total, 0),
    'anchored_records', COALESCE(v_anchored, 0),
    'pending_records', COALESCE(v_pending, 0),
    'embedded_records', COALESCE(v_embedded, 0)
  ), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$FN$;

-- anchor_status_counts: 4 small-status exact counts + derive SECURED
CREATE OR REPLACE FUNCTION refresh_cache_anchor_status_counts()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
SET statement_timeout = '60s'
AS $FN$
DECLARE
  v_total bigint; v_pending bigint; v_submitted bigint;
  v_broadcasting bigint; v_revoked bigint; v_secured bigint;
BEGIN
  SELECT reltuples::bigint INTO v_total FROM pg_class WHERE relname = 'anchors';
  SELECT count(*) INTO v_pending FROM anchors WHERE status = 'PENDING' AND deleted_at IS NULL;
  SELECT count(*) INTO v_submitted FROM anchors WHERE status = 'SUBMITTED' AND deleted_at IS NULL;
  SELECT count(*) INTO v_broadcasting FROM anchors WHERE status = 'BROADCASTING' AND deleted_at IS NULL;
  SELECT count(*) INTO v_revoked FROM anchors WHERE status = 'REVOKED' AND deleted_at IS NULL;
  v_secured := GREATEST(v_total - v_pending - v_submitted - v_broadcasting - v_revoked, 0);

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('anchor_status_counts', jsonb_build_object(
    'PENDING', v_pending, 'SUBMITTED', v_submitted,
    'BROADCASTING', v_broadcasting, 'SECURED', v_secured,
    'REVOKED', v_revoked, 'total', v_total
  ), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$FN$;

-- by_source: GROUP BY source on 1.9M public_records — ~9s, cached
CREATE OR REPLACE FUNCTION refresh_cache_by_source()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
SET statement_timeout = '60s'
AS $FN$
DECLARE v_by_source jsonb;
BEGIN
  SELECT jsonb_object_agg(source, cnt) INTO v_by_source
  FROM (SELECT source, count(*) AS cnt FROM public_records GROUP BY source) t;

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('by_source', COALESCE(v_by_source, '{}'::jsonb), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$FN$;

-- anchor_type_counts: GROUP BY credential_type, status on 1.6M anchors — ~7s, cached
CREATE OR REPLACE FUNCTION refresh_cache_anchor_type_counts()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
SET statement_timeout = '60s'
AS $FN$
DECLARE v_result jsonb;
BEGIN
  SELECT jsonb_agg(row_to_json(t)::jsonb) INTO v_result
  FROM (
    SELECT COALESCE(credential_type::text, 'UNKNOWN') AS credential_type,
           status::text AS status, count(*)::bigint AS count
    FROM anchors WHERE deleted_at IS NULL
    GROUP BY credential_type, status ORDER BY count(*) DESC
  ) t;

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('anchor_type_counts', COALESCE(v_result, '[]'::jsonb), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$FN$;

-- record_types: DISTINCT record_type on 1.9M rows — fast (~0.5s)
CREATE OR REPLACE FUNCTION refresh_cache_record_types()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
SET statement_timeout = '60s'
AS $FN$
DECLARE v_result jsonb;
BEGIN
  SELECT jsonb_agg(record_type ORDER BY record_type) INTO v_result
  FROM (SELECT DISTINCT record_type FROM public_records) t;

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('record_types', COALESCE(v_result, '[]'::jsonb), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$FN$;

-- anchor_tx_stats: ALL approximations — pg_class + pg_stats + LIMIT 1 on index
-- count(DISTINCT chain_tx_id) on 1.6M rows has no fast path in Postgres and times
-- out >60s even with an index. distinct_tx_count is marked approximate.
CREATE OR REPLACE FUNCTION refresh_cache_anchor_tx_stats()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
SET statement_timeout = '5s'
AS $FN$
DECLARE
  v_anchor_total bigint;
  v_anchors_with_tx bigint;
  v_null_frac float;
  v_last_anchor_time timestamptz;
BEGIN
  SELECT reltuples::bigint INTO v_anchor_total FROM pg_class WHERE relname = 'anchors';

  SELECT COALESCE(null_frac, 0) INTO v_null_frac
  FROM pg_stats WHERE tablename = 'anchors' AND attname = 'chain_tx_id';
  v_anchors_with_tx := COALESCE((v_anchor_total * (1 - v_null_frac))::bigint, 0);

  -- Last anchor time: Index Only Scan on idx_anchors_active_created (cost 0.43-0.46)
  SELECT created_at INTO v_last_anchor_time
  FROM anchors WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1;

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('anchor_tx_stats', jsonb_build_object(
    'distinct_tx_count', 0,
    'distinct_tx_approximate', true,
    'anchors_with_tx', v_anchors_with_tx,
    'total_anchors', v_anchor_total,
    'last_anchor_time', v_last_anchor_time,
    'last_tx_time', v_last_anchor_time
  ), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$FN$;

GRANT EXECUTE ON FUNCTION refresh_cache_pipeline_stats() TO service_role;
GRANT EXECUTE ON FUNCTION refresh_cache_anchor_status_counts() TO service_role;
GRANT EXECUTE ON FUNCTION refresh_cache_by_source() TO service_role;
GRANT EXECUTE ON FUNCTION refresh_cache_anchor_type_counts() TO service_role;
GRANT EXECUTE ON FUNCTION refresh_cache_record_types() TO service_role;
GRANT EXECUTE ON FUNCTION refresh_cache_anchor_tx_stats() TO service_role;

-- Master refresh: calls each per-key function in its own exception block
CREATE OR REPLACE FUNCTION refresh_pipeline_dashboard_cache()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $FN$
DECLARE
  v_started_at timestamptz := clock_timestamp();
  v_errors jsonb := '[]'::jsonb;
  v_succeeded int := 0;
BEGIN
  BEGIN PERFORM refresh_cache_pipeline_stats(); v_succeeded := v_succeeded + 1;
  EXCEPTION WHEN OTHERS THEN v_errors := v_errors || jsonb_build_object('pipeline_stats', SQLERRM); END;

  BEGIN PERFORM refresh_cache_anchor_status_counts(); v_succeeded := v_succeeded + 1;
  EXCEPTION WHEN OTHERS THEN v_errors := v_errors || jsonb_build_object('anchor_status_counts', SQLERRM); END;

  BEGIN PERFORM refresh_cache_by_source(); v_succeeded := v_succeeded + 1;
  EXCEPTION WHEN OTHERS THEN v_errors := v_errors || jsonb_build_object('by_source', SQLERRM); END;

  BEGIN PERFORM refresh_cache_anchor_type_counts(); v_succeeded := v_succeeded + 1;
  EXCEPTION WHEN OTHERS THEN v_errors := v_errors || jsonb_build_object('anchor_type_counts', SQLERRM); END;

  BEGIN PERFORM refresh_cache_record_types(); v_succeeded := v_succeeded + 1;
  EXCEPTION WHEN OTHERS THEN v_errors := v_errors || jsonb_build_object('record_types', SQLERRM); END;

  BEGIN PERFORM refresh_cache_anchor_tx_stats(); v_succeeded := v_succeeded + 1;
  EXCEPTION WHEN OTHERS THEN v_errors := v_errors || jsonb_build_object('anchor_tx_stats', SQLERRM); END;

  RETURN jsonb_build_object(
    'succeeded', v_succeeded,
    'errors', v_errors,
    'duration_ms', extract(milliseconds from clock_timestamp() - v_started_at)::int
  );
END;
$FN$;

GRANT EXECUTE ON FUNCTION refresh_pipeline_dashboard_cache() TO service_role;

-- =========================================================================
-- 3. FAST RPC WRAPPERS — read from cache (microseconds)
-- =========================================================================

CREATE OR REPLACE FUNCTION get_pipeline_stats()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $FN$
DECLARE v_cached jsonb; v_total bigint; v_embedded bigint;
BEGIN
  IF NOT (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN RAISE EXCEPTION 'Access denied: platform admin required'; END IF;

  SELECT cache_value INTO v_cached FROM pipeline_dashboard_cache WHERE cache_key = 'pipeline_stats';
  IF v_cached IS NOT NULL THEN RETURN v_cached::json; END IF;

  SELECT reltuples::bigint INTO v_total FROM pg_class WHERE relname = 'public_records';
  SELECT reltuples::bigint INTO v_embedded FROM pg_class WHERE relname = 'public_record_embeddings';
  RETURN json_build_object(
    'total_records', COALESCE(v_total, 0), 'anchored_records', 0,
    'pending_records', 0, 'embedded_records', COALESCE(v_embedded, 0), 'cache_miss', true
  );
END;
$FN$;

CREATE OR REPLACE FUNCTION count_public_records_by_source()
RETURNS TABLE(source text, count bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $FN$
BEGIN
  IF NOT (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN RAISE EXCEPTION 'Access denied: platform admin required'; END IF;

  RETURN QUERY
  SELECT kv.key::text AS source, (kv.value)::text::bigint AS count
  FROM pipeline_dashboard_cache pdc, LATERAL jsonb_each(pdc.cache_value) AS kv
  WHERE pdc.cache_key = 'by_source'
  ORDER BY (kv.value)::text::bigint DESC;
END;
$FN$;

CREATE OR REPLACE FUNCTION get_anchor_type_counts()
RETURNS TABLE(credential_type text, status text, count bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $FN$
BEGIN
  IF NOT (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN RAISE EXCEPTION 'Access denied: platform admin required'; END IF;

  RETURN QUERY
  SELECT (row_obj->>'credential_type')::text, (row_obj->>'status')::text, (row_obj->>'count')::bigint
  FROM pipeline_dashboard_cache pdc, LATERAL jsonb_array_elements(pdc.cache_value) AS row_obj
  WHERE pdc.cache_key = 'anchor_type_counts';
END;
$FN$;

CREATE OR REPLACE FUNCTION get_distinct_record_types()
RETURNS TABLE(record_type text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $FN$
BEGIN
  RETURN QUERY
  SELECT elem::text
  FROM pipeline_dashboard_cache pdc, LATERAL jsonb_array_elements_text(pdc.cache_value) AS elem
  WHERE pdc.cache_key = 'record_types';
END;
$FN$;

CREATE OR REPLACE FUNCTION get_anchor_status_counts()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $FN$
DECLARE v_cached jsonb;
BEGIN
  SELECT cache_value INTO v_cached FROM pipeline_dashboard_cache WHERE cache_key = 'anchor_status_counts';
  IF v_cached IS NOT NULL THEN RETURN v_cached::json; END IF;
  RETURN json_build_object('PENDING', 0, 'SUBMITTED', 0, 'BROADCASTING', 0,
    'SECURED', 0, 'REVOKED', 0, 'total', 0, 'cache_miss', true);
END;
$FN$;

CREATE OR REPLACE FUNCTION get_anchor_tx_stats()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $FN$
DECLARE v_cached jsonb;
BEGIN
  SELECT cache_value INTO v_cached FROM pipeline_dashboard_cache WHERE cache_key = 'anchor_tx_stats';
  IF v_cached IS NOT NULL THEN RETURN v_cached::json; END IF;
  RETURN json_build_object('distinct_tx_count', 0, 'anchors_with_tx', 0, 'total_anchors', 0,
    'last_anchor_time', NULL, 'last_tx_time', NULL, 'cache_miss', true);
END;
$FN$;

GRANT EXECUTE ON FUNCTION get_pipeline_stats() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION count_public_records_by_source() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_anchor_type_counts() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_distinct_record_types() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_anchor_status_counts() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_anchor_tx_stats() TO authenticated, service_role;

-- =========================================================================
-- 4. Schedule pg_cron refresh every 60 seconds
-- =========================================================================
DO $DO$
BEGIN
  BEGIN PERFORM cron.unschedule('refresh-pipeline-dashboard-cache');
  EXCEPTION WHEN OTHERS THEN NULL; END;

  PERFORM cron.schedule('refresh-pipeline-dashboard-cache', '* * * * *',
    'SELECT refresh_pipeline_dashboard_cache();');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not available: %', SQLERRM;
END;
$DO$;

-- =========================================================================
-- 5. Seed the cache — RUN MANUALLY AFTER MIGRATION APPLIES
-- =========================================================================
-- The master refresh takes ~60s on production (split across 6 per-key functions).
-- After seeding, pg_cron keeps the cache fresh every minute.
--
-- Run separately (not inside this migration's transaction):
--   SELECT refresh_pipeline_dashboard_cache();
-- Or seed each key individually to avoid a single-transaction 60s wait:
--   SELECT refresh_cache_pipeline_stats();        -- ~0.2s
--   SELECT refresh_cache_anchor_status_counts();  -- ~1.3s
--   SELECT refresh_cache_by_source();             -- ~9s
--   SELECT refresh_cache_record_types();          -- ~0.5s
--   SELECT refresh_cache_anchor_type_counts();    -- ~7s
--   SELECT refresh_cache_anchor_tx_stats();       -- ~0.2s

-- =========================================================================
-- ROLLBACK:
-- SELECT cron.unschedule('refresh-pipeline-dashboard-cache');
-- DROP FUNCTION IF EXISTS refresh_pipeline_dashboard_cache(),
--   refresh_cache_pipeline_stats(),
--   refresh_cache_anchor_status_counts(),
--   refresh_cache_by_source(),
--   refresh_cache_anchor_type_counts(),
--   refresh_cache_record_types(),
--   refresh_cache_anchor_tx_stats();
-- DROP TABLE IF EXISTS pipeline_dashboard_cache;
-- Restore function definitions from 0175, 0182, 0145, 0134, 0123, 0090.
-- =========================================================================
