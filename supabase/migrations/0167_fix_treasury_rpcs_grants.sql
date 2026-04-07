-- Migration: 0160_fix_treasury_rpcs_grants.sql
-- Fixes: SCRUM-359 — Treasury page shows all zeros despite 1.39M records
--
-- Root cause: get_anchor_tx_stats() was created in migration 0123 without
-- GRANT EXECUTE to authenticated/service_role. PostgREST returns permission
-- error, hook silently defaults to zeros.
--
-- Also re-creates get_anchor_tx_stats with statement_timeout and re-grants
-- get_anchor_status_counts for idempotent safety.
--
-- ROLLBACK: -- No destructive changes; GRANTs and CREATE OR REPLACE are safe.

-- =============================================================================
-- 1. Fix get_anchor_tx_stats: add statement_timeout + GRANT
-- =============================================================================

CREATE OR REPLACE FUNCTION get_anchor_tx_stats()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '15s'
AS $$
  SELECT json_build_object(
    'distinct_tx_count', (SELECT count(DISTINCT chain_tx_id) FROM anchors WHERE chain_tx_id IS NOT NULL AND deleted_at IS NULL),
    'anchors_with_tx', (SELECT count(*) FROM anchors WHERE chain_tx_id IS NOT NULL AND deleted_at IS NULL),
    'total_anchors', (SELECT count(*) FROM anchors WHERE deleted_at IS NULL),
    'last_anchor_time', (SELECT max(created_at) FROM anchors WHERE deleted_at IS NULL),
    'last_tx_time', (SELECT max(updated_at) FROM anchors WHERE chain_tx_id IS NOT NULL AND deleted_at IS NULL)
  );
$$;

GRANT EXECUTE ON FUNCTION get_anchor_tx_stats() TO authenticated;
GRANT EXECUTE ON FUNCTION get_anchor_tx_stats() TO service_role;

-- =============================================================================
-- 2. Idempotent re-grant on get_anchor_status_counts (safety)
-- =============================================================================

GRANT EXECUTE ON FUNCTION get_anchor_status_counts() TO authenticated;
GRANT EXECUTE ON FUNCTION get_anchor_status_counts() TO service_role;

-- =============================================================================
-- 3. Idempotent re-grant on get_treasury_stats (safety)
-- =============================================================================

GRANT EXECUTE ON FUNCTION get_treasury_stats() TO authenticated;
GRANT EXECUTE ON FUNCTION get_treasury_stats() TO service_role;

-- =============================================================================
-- 4. Notify PostgREST to reload schema cache
-- =============================================================================

NOTIFY pgrst, 'reload schema';
