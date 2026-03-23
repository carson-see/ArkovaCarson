-- Migration: 0087_org_members.sql
-- Description: Create org_members junction table for multi-org support.
--   Users can belong to multiple organizations with per-org roles.
--   Migrates existing profile.org_id data into org_members.
--   Updates organizations RLS to allow viewing all user's orgs.
-- ROLLBACK: DROP TABLE IF EXISTS org_members CASCADE; DROP FUNCTION IF EXISTS get_user_org_ids(); DROP POLICY IF EXISTS organizations_select_member ON organizations; CREATE POLICY organizations_select_own ON organizations FOR SELECT TO authenticated USING (id = get_user_org_id());

-- =============================================================================
-- 1. Create org_member_role enum
-- =============================================================================

CREATE TYPE org_member_role AS ENUM ('owner', 'admin', 'member');

-- =============================================================================
-- 2. Create org_members junction table
-- =============================================================================

CREATE TABLE org_members (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role       org_member_role NOT NULL DEFAULT 'member',
  joined_at  timestamptz NOT NULL DEFAULT now(),
  invited_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  CONSTRAINT org_members_unique_membership UNIQUE (user_id, org_id)
);

-- Indexes for common queries
CREATE INDEX idx_org_members_user_id ON org_members(user_id);
CREATE INDEX idx_org_members_org_id ON org_members(org_id);

-- Force RLS
ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_members FORCE ROW LEVEL SECURITY;

-- Grant access
GRANT SELECT, INSERT, UPDATE, DELETE ON org_members TO authenticated;

COMMENT ON TABLE org_members IS 'Junction table: users can belong to multiple organizations with per-org roles';
COMMENT ON COLUMN org_members.role IS 'owner = created the org, admin = can manage members/settings, member = can view records';

-- =============================================================================
-- 3. RLS policies for org_members
-- =============================================================================

-- Users can see members of orgs they belong to
CREATE POLICY org_members_select ON org_members
  FOR SELECT TO authenticated
  USING (
    org_id IN (SELECT om.org_id FROM org_members om WHERE om.user_id = auth.uid())
  );

-- Admins/owners can insert new members into their orgs
CREATE POLICY org_members_insert ON org_members
  FOR INSERT TO authenticated
  WITH CHECK (
    org_id IN (
      SELECT om.org_id FROM org_members om
      WHERE om.user_id = auth.uid() AND om.role IN ('owner', 'admin')
    )
  );

-- Admins/owners can update member roles in their orgs (not their own)
CREATE POLICY org_members_update ON org_members
  FOR UPDATE TO authenticated
  USING (
    org_id IN (
      SELECT om.org_id FROM org_members om
      WHERE om.user_id = auth.uid() AND om.role IN ('owner', 'admin')
    )
    AND user_id != auth.uid()  -- Can't change own role
  )
  WITH CHECK (
    org_id IN (
      SELECT om.org_id FROM org_members om
      WHERE om.user_id = auth.uid() AND om.role IN ('owner', 'admin')
    )
  );

-- Admins/owners can remove members (not themselves)
CREATE POLICY org_members_delete ON org_members
  FOR DELETE TO authenticated
  USING (
    org_id IN (
      SELECT om.org_id FROM org_members om
      WHERE om.user_id = auth.uid() AND om.role IN ('owner', 'admin')
    )
    AND user_id != auth.uid()  -- Can't remove self
  );

-- Members can leave orgs themselves (delete own membership)
CREATE POLICY org_members_self_leave ON org_members
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- =============================================================================
-- 4. Helper function: get all org IDs for current user
-- =============================================================================

CREATE OR REPLACE FUNCTION get_user_org_ids()
RETURNS SETOF uuid AS $$
  SELECT org_id FROM org_members WHERE user_id = auth.uid();
$$ LANGUAGE sql SECURITY INVOKER STABLE;

COMMENT ON FUNCTION get_user_org_ids() IS 'Returns all org IDs the current user belongs to';

-- =============================================================================
-- 5. Helper function: check if user is admin/owner in a specific org
-- =============================================================================

CREATE OR REPLACE FUNCTION is_org_admin_of(target_org_id uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = auth.uid()
    AND org_id = target_org_id
    AND role IN ('owner', 'admin')
  );
$$ LANGUAGE sql SECURITY INVOKER STABLE;

COMMENT ON FUNCTION is_org_admin_of(uuid) IS 'Returns true if current user is admin/owner of the specified org';

-- =============================================================================
-- 6. Migrate existing profile.org_id data into org_members
-- =============================================================================

INSERT INTO org_members (user_id, org_id, role)
SELECT
  p.id,
  p.org_id,
  CASE
    WHEN p.role = 'ORG_ADMIN' THEN 'owner'::org_member_role
    ELSE 'member'::org_member_role
  END
FROM profiles p
WHERE p.org_id IS NOT NULL
ON CONFLICT (user_id, org_id) DO NOTHING;

-- =============================================================================
-- 7. Update organizations RLS: allow viewing all orgs user belongs to
-- =============================================================================

-- Drop the old single-org SELECT policy
DROP POLICY IF EXISTS organizations_select_own ON organizations;

-- New policy: users can see any org they are a member of
-- Platform admin pages use service_role key via worker API, not RLS bypass
CREATE POLICY organizations_select_member ON organizations
  FOR SELECT TO authenticated
  USING (id IN (SELECT get_user_org_ids()));

-- =============================================================================
-- 8. Update organizations UPDATE policy to use org_members
-- =============================================================================

DROP POLICY IF EXISTS organizations_update_admin ON organizations;

CREATE POLICY organizations_update_admin ON organizations
  FOR UPDATE TO authenticated
  USING (is_org_admin_of(id))
  WITH CHECK (is_org_admin_of(id));
