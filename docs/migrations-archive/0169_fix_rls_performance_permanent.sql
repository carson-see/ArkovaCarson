-- Migration 0169: Permanent RLS performance fix for 1.4M+ record tables
--
-- Problem: Platform admin (carson@arkova.ai) owns 1.4M pipeline records.
-- RLS policies with inline subqueries were evaluated per-row, causing timeouts.
--
-- Fix: SECURITY DEFINER helper functions evaluated once per statement via STABLE.
-- Postgres caches the result for the entire query, not per-row.

-- ---------------------------------------------------------------------------
-- 1. Create SECURITY DEFINER helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_current_user_platform_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT is_platform_admin FROM profiles WHERE id = auth.uid()),
    false
  );
$$;

COMMENT ON FUNCTION is_current_user_platform_admin IS 'SECURITY DEFINER: checks if current user is platform admin. Cached per statement via STABLE.';

CREATE OR REPLACE FUNCTION get_user_org_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT org_id FROM profiles WHERE id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- 2. Replace anchors RLS policies with fast function-based versions
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS anchors_select_platform_admin ON anchors;
CREATE POLICY anchors_select_platform_admin ON anchors
  FOR SELECT TO authenticated
  USING (is_current_user_platform_admin());

DROP POLICY IF EXISTS anchors_select_org ON anchors;
CREATE POLICY anchors_select_org ON anchors
  FOR SELECT TO authenticated
  USING (org_id = get_user_org_id());

-- ---------------------------------------------------------------------------
-- 3. Fix attestations policy to use SECURITY DEFINER function
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS attestations_select ON attestations;
CREATE POLICY attestations_select ON attestations
  FOR SELECT TO authenticated
  USING (
    attester_user_id = auth.uid()
    OR attester_org_id = get_user_org_id()
    OR EXISTS (
      SELECT 1 FROM anchors a
      WHERE a.id = attestations.anchor_id
      AND a.user_id = auth.uid()
    )
    OR status = 'ACTIVE'
  );

-- ---------------------------------------------------------------------------
-- ROLLBACK:
-- Restore inline subquery policies from 0152/0010
-- ---------------------------------------------------------------------------
