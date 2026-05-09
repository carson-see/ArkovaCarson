-- Migration: Add get_anchor_tx_stats() RPC for accurate Treasury dashboard stats
-- Fixes PostgREST 1000-row cap bug that showed wrong Avg Anchors/TX (67 instead of ~1,115)
-- ROLLBACK: DROP FUNCTION IF EXISTS get_anchor_tx_stats();

CREATE OR REPLACE FUNCTION get_anchor_tx_stats()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT json_build_object(
    'distinct_tx_count', (SELECT count(DISTINCT chain_tx_id) FROM anchors WHERE chain_tx_id IS NOT NULL AND deleted_at IS NULL),
    'anchors_with_tx', (SELECT count(*) FROM anchors WHERE chain_tx_id IS NOT NULL AND deleted_at IS NULL),
    'total_anchors', (SELECT count(*) FROM anchors WHERE deleted_at IS NULL),
    'last_anchor_time', (SELECT max(created_at) FROM anchors WHERE deleted_at IS NULL),
    'last_tx_time', (SELECT max(updated_at) FROM anchors WHERE chain_tx_id IS NOT NULL AND deleted_at IS NULL)
  );
$$;
