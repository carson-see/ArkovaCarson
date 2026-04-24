-- Migration 0215: Emergency Pipeline + Treasury Dashboard Performance Fix

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

CREATE OR REPLACE FUNCTION refresh_pipeline_dashboard_cache()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $FN$
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
  SELECT reltuples::bigint INTO v_total_records FROM pg_class WHERE relname = 'public_records';
  SELECT reltuples::bigint INTO v_embedded_records FROM pg_class WHERE relname = 'public_record_embeddings';
  SELECT reltuples::bigint INTO v_anchor_total FROM pg_class WHERE relname = 'anchors';

  SELECT
    COALESCE(round(v_total_records * (1 - s.null_frac))::bigint, 0),
    COALESCE(round(v_total_records * s.null_frac)::bigint, 0)
  INTO v_anchored_records, v_pending_records
  FROM pg_stats s
  WHERE s.tablename = 'public_records' AND s.attname = 'anchor_id';

  IF v_anchored_records IS NULL OR v_anchored_records = 0 THEN
    SELECT count(*) INTO v_anchored_records FROM public_records WHERE anchor_id IS NOT NULL;
    v_pending_records := GREATEST(v_total_records - v_anchored_records, 0);
  END IF;

  SELECT count(*) INTO v_anchor_pending FROM anchors WHERE status = 'PENDING' AND deleted_at IS NULL;
  SELECT count(*) INTO v_anchor_submitted FROM anchors WHERE status = 'SUBMITTED' AND deleted_at IS NULL;
  SELECT count(*) INTO v_anchor_broadcasting FROM anchors WHERE status = 'BROADCASTING' AND deleted_at IS NULL;
  SELECT count(*) INTO v_anchor_revoked FROM anchors WHERE status = 'REVOKED' AND deleted_at IS NULL;
  v_anchor_secured := GREATEST(v_anchor_total - v_anchor_pending - v_anchor_submitted - v_anchor_broadcasting - v_anchor_revoked, 0);

  SELECT jsonb_object_agg(source, cnt) INTO v_by_source
  FROM (SELECT source, count(*) AS cnt FROM public_records GROUP BY source) t;

  SELECT jsonb_agg(row_to_json(t)::jsonb) INTO v_by_credential_type
  FROM (
    SELECT COALESCE(credential_type::text, 'UNKNOWN') AS credential_type,
           status::text AS status, count(*)::bigint AS count
    FROM anchors WHERE deleted_at IS NULL
    GROUP BY credential_type, status ORDER BY count(*) DESC
  ) t;

  SELECT jsonb_agg(record_type ORDER BY record_type) INTO v_record_types
  FROM (SELECT DISTINCT record_type FROM public_records) t;

  SELECT count(DISTINCT chain_tx_id), count(*) INTO v_distinct_tx, v_anchors_with_tx
  FROM anchors WHERE chain_tx_id IS NOT NULL AND deleted_at IS NULL;

  SELECT max(created_at) INTO v_last_anchor_time FROM anchors WHERE deleted_at IS NULL;
  SELECT max(updated_at) INTO v_last_tx_time FROM anchors WHERE chain_tx_id IS NOT NULL AND deleted_at IS NULL;

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at) VALUES
    ('pipeline_stats', jsonb_build_object(
      'total_records', v_total_records, 'anchored_records', v_anchored_records,
      'pending_records', v_pending_records, 'embedded_records', v_embedded_records), now()),
    ('by_source', COALESCE(v_by_source, '{}'::jsonb), now()),
    ('anchor_type_counts', COALESCE(v_by_credential_type, '[]'::jsonb), now()),
    ('record_types', COALESCE(v_record_types, '[]'::jsonb), now()),
    ('anchor_status_counts', jsonb_build_object(
      'PENDING', v_anchor_pending, 'SUBMITTED', v_anchor_submitted,
      'BROADCASTING', v_anchor_broadcasting, 'SECURED', v_anchor_secured,
      'REVOKED', v_anchor_revoked, 'total', v_anchor_total), now()),
    ('anchor_tx_stats', jsonb_build_object(
      'distinct_tx_count', COALESCE(v_distinct_tx, 0),
      'anchors_with_tx', COALESCE(v_anchors_with_tx, 0),
      'total_anchors', v_anchor_total,
      'last_anchor_time', v_last_anchor_time, 'last_tx_time', v_last_tx_time), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;

  RETURN jsonb_build_object(
    'refreshed_keys', 6,
    'duration_ms', extract(milliseconds from clock_timestamp() - v_started_at)::int
  );
END;
$FN$;

GRANT EXECUTE ON FUNCTION refresh_pipeline_dashboard_cache() TO service_role;

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

GRANT EXECUTE ON FUNCTION get_pipeline_stats() TO authenticated, service_role;

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

GRANT EXECUTE ON FUNCTION count_public_records_by_source() TO authenticated, service_role;

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

GRANT EXECUTE ON FUNCTION get_anchor_type_counts() TO authenticated, service_role;

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

GRANT EXECUTE ON FUNCTION get_distinct_record_types() TO authenticated, service_role;

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

GRANT EXECUTE ON FUNCTION get_anchor_status_counts() TO authenticated, service_role;

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

GRANT EXECUTE ON FUNCTION get_anchor_tx_stats() TO authenticated, service_role;

DO $DO$
BEGIN
  BEGIN PERFORM cron.unschedule('refresh-pipeline-dashboard-cache');
  EXCEPTION WHEN OTHERS THEN NULL; END;

  PERFORM cron.schedule('refresh-pipeline-dashboard-cache', '* * * * *',
    'SELECT refresh_pipeline_dashboard_cache();');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not available: %', SQLERRM;
END;
$DO$;;
