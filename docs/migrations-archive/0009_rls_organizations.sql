-- Migration: 0009_rls_organizations.sql
-- Description: RLS policies for organizations table
-- Rollback: DROP POLICY IF EXISTS organizations_select_own ON organizations; DROP POLICY IF EXISTS organizations_update_admin ON organizations;

-- =============================================================================
-- HELPER FUNCTION: Get current user's organization
-- =============================================================================

CREATE OR REPLACE FUNCTION get_user_org_id()
RETURNS uuid AS $$
  SELECT org_id FROM profiles WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY INVOKER STABLE;

-- =============================================================================
-- HELPER FUNCTION: Check if current user is ORG_ADMIN
-- =============================================================================

CREATE OR REPLACE FUNCTION is_org_admin()
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
    AND role = 'ORG_ADMIN'
  );
$$ LANGUAGE sql SECURITY INVOKER STABLE;

-- =============================================================================
-- SELECT POLICY: Users can only see their own organization
-- =============================================================================

CREATE POLICY organizations_select_own ON organizations
  FOR SELECT
  TO authenticated
  USING (id = get_user_org_id());

-- =============================================================================
-- UPDATE POLICY: Only ORG_ADMIN can update their organization
-- =============================================================================

CREATE POLICY organizations_update_admin ON organizations
  FOR UPDATE
  TO authenticated
  USING (
    id = get_user_org_id()
    AND is_org_admin()
  )
  WITH CHECK (
    id = get_user_org_id()
    AND is_org_admin()
  );

-- =============================================================================
-- INSERT POLICY: Organization creation is admin-only (no user policy)
-- =============================================================================

-- Organizations are created by system/admin, not by regular users
-- No INSERT policy for authenticated users

-- =============================================================================
-- DELETE POLICY: Organizations cannot be deleted by users
-- =============================================================================

-- No DELETE policy for authenticated users
-- Deletion should be handled by admin processes if needed

-- Comments
COMMENT ON FUNCTION get_user_org_id() IS 'Returns the org_id for the current authenticated user';
COMMENT ON FUNCTION is_org_admin() IS 'Returns true if current user has ORG_ADMIN role';
COMMENT ON POLICY organizations_select_own ON organizations IS 'Users can only view their own organization';
COMMENT ON POLICY organizations_update_admin ON organizations IS 'Only ORG_ADMIN can update their organization';
