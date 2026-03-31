-- Migration: 0152_fix_critical_rls_performance.sql
-- Fixes: SCRUM-348, SCRUM-349, SCRUM-352
-- Description: Fix 500 errors on anchors/attestations/search APIs caused by
--   1.39M+ rows making RLS policies and search catastrophically slow for platform admins.
--
-- Root cause: Platform admin (carson@arkova.ai) owns all pipeline records.
--   - anchors_select_own policy returns 1.39M rows → PostgREST timeout
--   - attestations_select subquery scans 1.39M anchors → timeout
--   - search_public_credentials does ILIKE on metadata::text for 1.39M rows → timeout
--
-- Fix:
--   1. Create is_current_user_platform_admin() SECURITY DEFINER helper
--   2. Add platform admin bypass policies to anchors and attestations
--   3. Optimize search_public_credentials with row limits and smarter filtering
--   4. Fix attestations RLS to use EXISTS instead of IN for anchor subquery
--   5. Notify PostgREST to reload schema cache (fixes SCRUM-351 too)
--
-- ROLLBACK:
--   DROP POLICY IF EXISTS anchors_select_platform_admin ON anchors;
--   DROP POLICY IF EXISTS attestations_select_platform_admin ON attestations;
--   DROP FUNCTION IF EXISTS is_current_user_platform_admin();
--   -- Then re-create original search_public_credentials from 0074

-- =============================================================================
-- 1. Platform admin helper function
-- =============================================================================

CREATE OR REPLACE FUNCTION is_current_user_platform_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT COALESCE(
    (SELECT is_platform_admin FROM profiles WHERE id = auth.uid()),
    false
  );
$$;

COMMENT ON FUNCTION is_current_user_platform_admin() IS
  'SECURITY DEFINER check for platform admin status. Used in RLS policies to short-circuit expensive row scanning.';

GRANT EXECUTE ON FUNCTION is_current_user_platform_admin() TO authenticated;

-- =============================================================================
-- 2. Platform admin bypass policy for anchors
-- =============================================================================
-- Platform admins can see ALL anchors without row-by-row filtering.
-- This prevents the 1.39M row scan that causes PostgREST timeouts.

CREATE POLICY anchors_select_platform_admin ON anchors
  FOR SELECT
  TO authenticated
  USING (is_current_user_platform_admin());

-- =============================================================================
-- 3. Platform admin bypass policy for attestations
-- =============================================================================

CREATE POLICY attestations_select_platform_admin ON attestations
  FOR SELECT
  TO authenticated
  USING (is_current_user_platform_admin());

-- =============================================================================
-- 4. Fix attestations_select policy: EXISTS instead of IN
-- =============================================================================
-- The original policy used:
--   anchor_id IN (SELECT id FROM anchors WHERE user_id = auth.uid())
-- For users with 1.39M anchors, this generates a 1.39M-element IN list.
-- Replace with EXISTS which short-circuits after first match.

DROP POLICY IF EXISTS attestations_select ON attestations;

CREATE POLICY attestations_select ON attestations FOR SELECT USING (
  attester_user_id = auth.uid()
  OR attester_org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  OR EXISTS (
    SELECT 1 FROM anchors a
    WHERE a.id = attestations.anchor_id
    AND a.user_id = auth.uid()
  )
  OR status = 'ACTIVE'
);

-- =============================================================================
-- 5. Optimize search_public_credentials
-- =============================================================================
-- Replace ILIKE on metadata::text (full table scan) with targeted search.
-- Add early-exit LIMIT and avoid JSONB-to-text conversion on every row.

CREATE OR REPLACE FUNCTION search_public_credentials(p_query text, p_limit integer DEFAULT 10)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer;
  v_pattern text;
BEGIN
  -- Clamp limit
  v_limit := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);

  -- Reject empty or too-short queries
  IF p_query IS NULL OR length(trim(p_query)) < 2 THEN
    RETURN;
  END IF;

  v_pattern := '%' || trim(p_query) || '%';

  RETURN QUERY
  SELECT jsonb_build_object(
    'public_id', a.public_id,
    'title', a.filename,
    'credential_type', a.credential_type,
    'status', a.status,
    'created_at', a.created_at,
    'org_id', a.org_id
  )
  FROM anchors a
  WHERE a.status IN ('SECURED', 'SUBMITTED')
    AND a.deleted_at IS NULL
    AND (
      a.filename ILIKE v_pattern
      OR a.credential_type::text ILIKE v_pattern
      OR a.description ILIKE v_pattern
    )
  ORDER BY a.created_at DESC
  LIMIT v_limit;
END;
$$;

-- Note: metadata::text ILIKE removed — it was doing full JSONB-to-text conversion
-- on every row. If metadata search is needed, use a GIN index on metadata instead.

-- =============================================================================
-- 6. Search indexes — already created by 0150_fix_search_performance_indexes.sql
--    (idx_anchors_filename_trgm, idx_anchors_description_trgm,
--     idx_anchors_credential_type_btree, idx_anchors_status_secured_submitted)
-- =============================================================================

-- =============================================================================
-- 7. Notify PostgREST to reload schema cache
-- =============================================================================
-- This ensures PostgREST picks up any functions added by prior migrations
-- that may not have been detected (fixes SCRUM-351 lookup_org_by_email_domain 400).

NOTIFY pgrst, 'reload schema';
