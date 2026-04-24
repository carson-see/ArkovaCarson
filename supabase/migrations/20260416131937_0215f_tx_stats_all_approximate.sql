-- All approximations — no table scans. Uses pg_class reltuples and pg_stats.

CREATE OR REPLACE FUNCTION refresh_cache_anchor_tx_stats()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
SET statement_timeout = '10s'
AS $FN$
DECLARE
  v_anchor_total bigint;
  v_anchors_with_tx bigint;
  v_null_frac float;
  v_last_anchor_time timestamptz;
  v_last_tx_time timestamptz;
BEGIN
  -- Total from pg_class
  SELECT reltuples::bigint INTO v_anchor_total FROM pg_class WHERE relname = 'anchors';

  -- Anchors with tx from pg_stats
  SELECT COALESCE(null_frac, 0) INTO v_null_frac
  FROM pg_stats WHERE tablename = 'anchors' AND attname = 'chain_tx_id';
  v_anchors_with_tx := COALESCE((v_anchor_total * (1 - v_null_frac))::bigint, 0);

  -- Last anchor time: use index via LIMIT 1 ORDER BY DESC
  BEGIN
    SELECT created_at INTO v_last_anchor_time
    FROM anchors
    WHERE deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_last_anchor_time := NULL;
  END;

  -- Last tx time via the partial index idx_anchors_submitted_chain_tx (if recent)
  BEGIN
    SELECT updated_at INTO v_last_tx_time
    FROM anchors
    WHERE chain_tx_id IS NOT NULL AND deleted_at IS NULL
    ORDER BY updated_at DESC
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_last_tx_time := v_last_anchor_time;
  END;

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('anchor_tx_stats', jsonb_build_object(
    'distinct_tx_count', 0,
    'distinct_tx_approximate', true,
    'anchors_with_tx', v_anchors_with_tx,
    'total_anchors', v_anchor_total,
    'last_anchor_time', v_last_anchor_time,
    'last_tx_time', v_last_tx_time
  ), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$FN$;

GRANT EXECUTE ON FUNCTION refresh_cache_anchor_tx_stats() TO service_role;;
