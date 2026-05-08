-- =============================================================================
-- Migration 0109: Fix org_members RLS infinite recursion
-- Story: Session fix — org_members self-referencing policies cause recursion
-- Date: 2026-03-24
--
-- PURPOSE
-- -------
-- The org_members SELECT/INSERT/UPDATE/DELETE policies from 0087 contain
-- direct subqueries against org_members itself, e.g.:
--   USING (org_id IN (SELECT om.org_id FROM org_members om WHERE om.user_id = auth.uid()))
-- This causes "infinite recursion detected in policy for relation org_members".
--
-- Fix: Replace self-referencing subqueries with get_user_org_ids() and
-- is_org_admin_of(), which are SECURITY DEFINER (from 0107) and bypass RLS.
-- Also add a direct "see own membership" policy that avoids any self-reference.
-- =============================================================================

-- 1. Drop all existing org_members policies
DROP POLICY IF EXISTS org_members_select ON org_members;
DROP POLICY IF EXISTS org_members_insert ON org_members;
DROP POLICY IF EXISTS org_members_update ON org_members;
DROP POLICY IF EXISTS org_members_delete ON org_members;
DROP POLICY IF EXISTS org_members_self_leave ON org_members;

-- 2. SELECT: users can see their own memberships (no self-reference)
CREATE POLICY org_members_select_own ON org_members
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- 3. SELECT: users can see other members of orgs they belong to
--    Uses SECURITY DEFINER get_user_org_ids() to avoid recursion
CREATE POLICY org_members_select_org ON org_members
  FOR SELECT TO authenticated
  USING (org_id IN (SELECT get_user_org_ids()));

-- 4. INSERT: admins/owners can add members to their orgs
CREATE POLICY org_members_insert ON org_members
  FOR INSERT TO authenticated
  WITH CHECK (is_org_admin_of(org_id));

-- 5. UPDATE: admins/owners can update member roles (not their own)
CREATE POLICY org_members_update ON org_members
  FOR UPDATE TO authenticated
  USING (is_org_admin_of(org_id) AND user_id != auth.uid())
  WITH CHECK (is_org_admin_of(org_id));

-- 6. DELETE: admins/owners can remove members (not themselves)
CREATE POLICY org_members_delete ON org_members
  FOR DELETE TO authenticated
  USING (is_org_admin_of(org_id) AND user_id != auth.uid());

-- 7. DELETE: members can leave orgs themselves
CREATE POLICY org_members_self_leave ON org_members
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- DROP POLICY IF EXISTS org_members_select_own ON org_members;
-- DROP POLICY IF EXISTS org_members_select_org ON org_members;
-- DROP POLICY IF EXISTS org_members_insert ON org_members;
-- DROP POLICY IF EXISTS org_members_update ON org_members;
-- DROP POLICY IF EXISTS org_members_delete ON org_members;
-- DROP POLICY IF EXISTS org_members_self_leave ON org_members;
-- Then re-apply the original self-referencing policies from 0087_org_members.sql:
-- CREATE POLICY org_members_select ON org_members FOR SELECT TO authenticated
--   USING (org_id IN (SELECT om.org_id FROM org_members om WHERE om.user_id = auth.uid()));
-- CREATE POLICY org_members_insert ON org_members FOR INSERT TO authenticated
--   WITH CHECK (org_id IN (SELECT om.org_id FROM org_members om WHERE om.user_id = auth.uid() AND om.role IN ('owner','admin')));
-- CREATE POLICY org_members_update ON org_members FOR UPDATE TO authenticated
--   USING (org_id IN (SELECT om.org_id FROM org_members om WHERE om.user_id = auth.uid() AND om.role IN ('owner','admin')) AND user_id != auth.uid());
-- CREATE POLICY org_members_delete ON org_members FOR DELETE TO authenticated
--   USING (org_id IN (SELECT om.org_id FROM org_members om WHERE om.user_id = auth.uid() AND om.role IN ('owner','admin')) AND user_id != auth.uid());
-- CREATE POLICY org_members_self_leave ON org_members FOR DELETE TO authenticated
--   USING (user_id = auth.uid());
