-- Migration 0182: Fix get_anchor_status_counts timeout on 1.4M row anchors table
--
-- Problem: get_anchor_status_counts() does count(*) GROUP BY status on anchors
-- (1.4M rows), causing timeouts on every Admin Overview page load. The fallback
-- count:exact queries also timeout due to RLS on the same table.
--
-- Fix: Replace with get_anchor_status_counts_fast() that uses reltuples estimate
-- for total count (instant), exact counts for small statuses (PENDING, SUBMITTED,
-- BROADCASTING, REVOKED — typically <100K combined), and derives SECURED count
-- as total minus the sum of small statuses. Same pattern as 0175's get_pipeline_stats.

-- =========================================================================
-- 1. Create fast version with admin access check + reltuples hybrid
-- =========================================================================
CREATE OR REPLACE FUNCTION get_anchor_status_counts_fast()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_total bigint;
  v_pending bigint;
  v_submitted bigint;
  v_broadcasting bigint;
  v_revoked bigint;
  v_secured bigint;
BEGIN
  -- Admin-only access check (same pattern as get_pipeline_stats)
  IF NOT (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN
    RAISE EXCEPTION 'Access denied: platform admin required';
  END IF;

  -- Total from pg_class reltuples (instant, updated by ANALYZE)
  SELECT reltuples::bigint INTO v_total
  FROM pg_class WHERE relname = 'anchors';

  -- Exact counts for small statuses (fast — typically <100K combined)
  -- Uses idx_anchors_credential_type_status composite index
  SELECT count(*) INTO v_pending
  FROM anchors WHERE status = 'PENDING' AND deleted_at IS NULL;

  SELECT count(*) INTO v_submitted
  FROM anchors WHERE status = 'SUBMITTED' AND deleted_at IS NULL;

  SELECT count(*) INTO v_broadcasting
  FROM anchors WHERE status = 'BROADCASTING' AND deleted_at IS NULL;

  SELECT count(*) INTO v_revoked
  FROM anchors WHERE status = 'REVOKED' AND deleted_at IS NULL;

  -- Derive SECURED as total minus small statuses (avoids counting 1.28M rows)
  v_secured := GREATEST(v_total - v_pending - v_submitted - v_broadcasting - v_revoked, 0);

  RETURN json_build_object(
    'PENDING', v_pending,
    'SUBMITTED', v_submitted,
    'BROADCASTING', v_broadcasting,
    'SECURED', v_secured,
    'REVOKED', v_revoked,
    'total', v_total
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_anchor_status_counts_fast() TO authenticated;
GRANT EXECUTE ON FUNCTION get_anchor_status_counts_fast() TO service_role;

-- =========================================================================
-- 2. Add partial index on anchors(status) for non-SECURED rows
--    Makes the small-status exact counts even faster
-- =========================================================================
CREATE INDEX IF NOT EXISTS idx_anchors_status_non_secured
ON anchors (status) WHERE status != 'SECURED' AND deleted_at IS NULL;

-- =========================================================================
-- ROLLBACK:
-- DROP FUNCTION IF EXISTS get_anchor_status_counts_fast();
-- DROP INDEX IF EXISTS idx_anchors_status_non_secured;
-- =========================================================================
