-- Split refresh into per-key functions so a slow query on one key doesn't kill all refreshes.

-- 1) pipeline_stats: uses pg_stats — instant
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

-- 2) anchor_status_counts: 4 small-status exact counts, derive SECURED
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

-- 3) by_source: expensive GROUP BY on 1.9M rows
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

-- 4) anchor_type_counts: expensive GROUP BY on 1.6M rows
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

-- 5) record_types: DISTINCT on 1.9M rows
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

-- 6) anchor_tx_stats: count(DISTINCT chain_tx_id) is the killer
CREATE OR REPLACE FUNCTION refresh_cache_anchor_tx_stats()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
SET statement_timeout = '90s'
AS $FN$
DECLARE
  v_anchor_total bigint;
  v_distinct_tx bigint;
  v_anchors_with_tx bigint;
  v_last_anchor_time timestamptz;
  v_last_tx_time timestamptz;
BEGIN
  SELECT reltuples::bigint INTO v_anchor_total FROM pg_class WHERE relname = 'anchors';
  SELECT count(DISTINCT chain_tx_id), count(*) INTO v_distinct_tx, v_anchors_with_tx
  FROM anchors WHERE chain_tx_id IS NOT NULL AND deleted_at IS NULL;
  SELECT max(created_at) INTO v_last_anchor_time FROM anchors WHERE deleted_at IS NULL;
  SELECT max(updated_at) INTO v_last_tx_time FROM anchors WHERE chain_tx_id IS NOT NULL AND deleted_at IS NULL;

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('anchor_tx_stats', jsonb_build_object(
    'distinct_tx_count', COALESCE(v_distinct_tx, 0),
    'anchors_with_tx', COALESCE(v_anchors_with_tx, 0),
    'total_anchors', v_anchor_total,
    'last_anchor_time', v_last_anchor_time, 'last_tx_time', v_last_tx_time
  ), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$FN$;

-- Grants
GRANT EXECUTE ON FUNCTION refresh_cache_pipeline_stats() TO service_role;
GRANT EXECUTE ON FUNCTION refresh_cache_anchor_status_counts() TO service_role;
GRANT EXECUTE ON FUNCTION refresh_cache_by_source() TO service_role;
GRANT EXECUTE ON FUNCTION refresh_cache_anchor_type_counts() TO service_role;
GRANT EXECUTE ON FUNCTION refresh_cache_record_types() TO service_role;
GRANT EXECUTE ON FUNCTION refresh_cache_anchor_tx_stats() TO service_role;

-- New master refresh that runs each in its own transaction-isolated block
-- so a failure on one doesn't roll back the others.
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

GRANT EXECUTE ON FUNCTION refresh_pipeline_dashboard_cache() TO service_role;;
