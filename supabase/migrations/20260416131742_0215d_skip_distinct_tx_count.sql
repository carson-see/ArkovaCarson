-- Skip count(DISTINCT chain_tx_id) — it's O(rows) on 1.4M+ rows with no fast path.
-- Use anchors_with_tx only; distinct_tx_count derived elsewhere (e.g., from separately-tracked chain_txs table or omit).

CREATE OR REPLACE FUNCTION refresh_cache_anchor_tx_stats()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
SET statement_timeout = '30s'
AS $FN$
DECLARE
  v_anchor_total bigint;
  v_anchors_with_tx bigint;
  v_last_anchor_time timestamptz;
  v_last_tx_time timestamptz;
  v_distinct_tx bigint;
BEGIN
  SELECT reltuples::bigint INTO v_anchor_total FROM pg_class WHERE relname = 'anchors';

  -- Anchors with tx: count on partial index (seen working at ~1s)
  SELECT count(*) INTO v_anchors_with_tx
  FROM anchors WHERE chain_tx_id IS NOT NULL AND deleted_at IS NULL;

  -- Last anchor created: fast via idx_anchors_active_created
  SELECT max(created_at) INTO v_last_anchor_time
  FROM anchors WHERE deleted_at IS NULL;

  -- Last tx updated: partial index on chain_tx_id. Limit to last 30 days window (narrows scan).
  SELECT max(updated_at) INTO v_last_tx_time
  FROM anchors
  WHERE chain_tx_id IS NOT NULL AND deleted_at IS NULL
    AND updated_at > now() - interval '30 days';

  -- Distinct TX count: derive from chain_txs table if it exists, else skip.
  -- Previous get_anchor_status_counts (now replaced) returned 432.
  -- For now, use a cheap approximation: count distinct via index-only scan with 60s cap,
  -- fall back to 0 on timeout.
  BEGIN
    EXECUTE 'SET LOCAL statement_timeout = ''15s''';
    -- Index-only scan on idx_anchors_chain_tx_id (partial, covers the WHERE clause)
    SELECT count(*) INTO v_distinct_tx FROM (
      SELECT chain_tx_id FROM anchors
      WHERE chain_tx_id IS NOT NULL AND deleted_at IS NULL
      GROUP BY chain_tx_id
    ) t;
  EXCEPTION WHEN query_canceled OR others THEN
    -- Fallback: compute from previous cache value or approximate from anchors_with_tx
    SELECT COALESCE((cache_value->>'distinct_tx_count')::bigint, 0) INTO v_distinct_tx
    FROM pipeline_dashboard_cache WHERE cache_key = 'anchor_tx_stats';
    v_distinct_tx := COALESCE(v_distinct_tx, 0);
  END;

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('anchor_tx_stats', jsonb_build_object(
    'distinct_tx_count', v_distinct_tx,
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
