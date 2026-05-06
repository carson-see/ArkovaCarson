-- Migration: 0024_fix_anchors_rls_timeout.sql
-- Description: Fix PG 57014 statement timeout on org registry anchors query.
--   The anchors_select_org RLS policy calls get_user_org_id() and is_org_admin()
--   which each perform a profiles lookup per-row, causing timeouts.
--   Fix: replace the two-function policy with a single subquery, and add a
--   composite index covering the common org registry query pattern.
-- Rollback:
--   DROP POLICY IF EXISTS anchors_select_org ON anchors;
--   CREATE POLICY anchors_select_org ON anchors FOR SELECT TO authenticated
--     USING (org_id = get_user_org_id() AND is_org_admin());
--   DROP INDEX IF EXISTS idx_anchors_org_deleted_created;

-- =============================================================================
-- 1. Add composite index for org registry query pattern:
--    WHERE org_id = ? AND deleted_at IS NULL ORDER BY created_at DESC
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_anchors_org_deleted_created
  ON anchors(org_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- =============================================================================
-- 2. Replace anchors_select_org policy with optimized single-subquery version
--    Instead of calling two functions (2 profile lookups), use one EXISTS subquery.
-- =============================================================================
DROP POLICY IF EXISTS anchors_select_org ON anchors;

CREATE POLICY anchors_select_org ON anchors
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND p.role = 'ORG_ADMIN'
        AND p.org_id = anchors.org_id
    )
  );

-- =============================================================================
-- 3. Ensure profiles has an index on (id, role, org_id) for the above subquery
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_profiles_id_role_org
  ON profiles(id, role, org_id);
