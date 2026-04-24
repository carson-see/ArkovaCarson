-- Final fix for anchor_tx_stats: skip count(DISTINCT) entirely.
-- Distinct TX count is derived from a separate running counter or approximated.

CREATE OR REPLACE FUNCTION refresh_cache_anchor_tx_stats()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
SET statement_timeout = '20s'
AS $FN$
DECLARE
  v_anchor_total bigint;
  v_anchors_with_tx bigint;
  v_last_anchor_time timestamptz;
  v_last_tx_time timestamptz;
  v_distinct_tx bigint;
BEGIN
  SELECT reltuples::bigint INTO v_anchor_total FROM pg_class WHERE relname = 'anchors';

  SELECT count(*) INTO v_anchors_with_tx
  FROM anchors WHERE chain_tx_id IS NOT NULL AND deleted_at IS NULL;

  SELECT max(created_at) INTO v_last_anchor_time
  FROM anchors WHERE deleted_at IS NULL;

  -- Narrow to last 30 days so index can be used efficiently
  SELECT max(updated_at) INTO v_last_tx_time
  FROM anchors
  WHERE chain_tx_id IS NOT NULL AND deleted_at IS NULL
    AND updated_at > now() - interval '30 days';

  -- Approximate distinct TX count: use avg batch size heuristic from recent activity.
  -- Query the last 1000 anchors and count distinct tx_ids there, scale up.
  SELECT CASE
    WHEN v_anchors_with_tx > 0 THEN
      GREATEST(
        (SELECT (count(*)::float / count(DISTINCT chain_tx_id)::float) FROM (
          SELECT chain_tx_id FROM anchors
          WHERE chain_tx_id IS NOT NULL AND deleted_at IS NULL
          ORDER BY created_at DESC
          LIMIT 5000
        ) sample),
        1.0
      )
    ELSE 1.0
  END::float INTO v_distinct_tx;

  -- Convert "avg anchors per tx" to "distinct txs" = anchors_with_tx / avg
  v_distinct_tx := CASE WHEN v_distinct_tx > 0
    THEN (v_anchors_with_tx / v_distinct_tx)::bigint
    ELSE 0
  END;

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('anchor_tx_stats', jsonb_build_object(
    'distinct_tx_count', v_distinct_tx,
    'distinct_tx_approximate', true,
    'anchors_with_tx', COALESCE(v_anchors_with_tx, 0),
    'total_anchors', v_anchor_total,
    'last_anchor_time', v_last_anchor_time,
    'last_tx_time', v_last_tx_time
  ), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$FN$;

GRANT EXECUTE ON FUNCTION refresh_cache_anchor_tx_stats() TO service_role;;
