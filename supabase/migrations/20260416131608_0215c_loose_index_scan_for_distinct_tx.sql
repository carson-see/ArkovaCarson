-- Use recursive loose index scan for count(DISTINCT chain_tx_id).
-- With only ~400 distinct TX IDs on 1.4M+ rows, this is O(distinct_count) using
-- the existing idx_anchors_chain_tx_id index (partial index on chain_tx_id).
-- Instant vs. 90s+ timeout.

CREATE OR REPLACE FUNCTION refresh_cache_anchor_tx_stats()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
SET statement_timeout = '60s'
AS $FN$
DECLARE
  v_anchor_total bigint;
  v_distinct_tx bigint;
  v_anchors_with_tx bigint;
  v_last_anchor_time timestamptz;
  v_last_tx_time timestamptz;
BEGIN
  SELECT reltuples::bigint INTO v_anchor_total FROM pg_class WHERE relname = 'anchors';

  -- Anchors with tx: index-only scan on partial index (fast)
  SELECT count(*) INTO v_anchors_with_tx
  FROM anchors WHERE chain_tx_id IS NOT NULL AND deleted_at IS NULL;

  -- Loose index scan for distinct chain_tx_id count (recursive skip-scan).
  -- Walks the index once per distinct value instead of scanning all rows.
  WITH RECURSIVE t AS (
    (SELECT chain_tx_id FROM anchors
      WHERE chain_tx_id IS NOT NULL AND deleted_at IS NULL
      ORDER BY chain_tx_id LIMIT 1)
    UNION ALL
    SELECT (SELECT chain_tx_id FROM anchors
             WHERE chain_tx_id > t.chain_tx_id AND chain_tx_id IS NOT NULL AND deleted_at IS NULL
             ORDER BY chain_tx_id LIMIT 1)
    FROM t WHERE t.chain_tx_id IS NOT NULL
  )
  SELECT count(*) INTO v_distinct_tx FROM t WHERE chain_tx_id IS NOT NULL;

  -- Last timestamps: use idx_anchors_active_created (fast)
  SELECT max(created_at) INTO v_last_anchor_time
  FROM anchors WHERE deleted_at IS NULL;

  SELECT max(updated_at) INTO v_last_tx_time
  FROM anchors WHERE chain_tx_id IS NOT NULL AND deleted_at IS NULL;

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

GRANT EXECUTE ON FUNCTION refresh_cache_anchor_tx_stats() TO service_role;;
