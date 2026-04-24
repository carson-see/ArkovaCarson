-- Pure approximation — no queries on anchors table beyond pg_class/pg_stats and a single LIMIT 1 via index.

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
  -- Total from pg_class (instant)
  SELECT reltuples::bigint INTO v_anchor_total FROM pg_class WHERE relname = 'anchors';

  -- Anchors with tx from pg_stats (instant)
  SELECT COALESCE(null_frac, 0) INTO v_null_frac
  FROM pg_stats WHERE tablename = 'anchors' AND attname = 'chain_tx_id';
  v_anchors_with_tx := COALESCE((v_anchor_total * (1 - v_null_frac))::bigint, 0);

  -- Last anchor time: Index Only Scan on idx_anchors_active_created (cost 0.43-0.46)
  SELECT created_at INTO v_last_anchor_time
  FROM anchors
  WHERE deleted_at IS NULL
  ORDER BY created_at DESC
  LIMIT 1;

  -- Skip last_tx_time — no index on updated_at; use last_anchor_time as proxy.

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

GRANT EXECUTE ON FUNCTION refresh_cache_anchor_tx_stats() TO service_role;;
