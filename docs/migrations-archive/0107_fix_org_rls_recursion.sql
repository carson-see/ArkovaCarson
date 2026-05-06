-- Migration 0107: Fix org RLS circular dependency
-- The is_org_admin_of() and get_user_org_ids() functions were SECURITY INVOKER,
-- which caused circular RLS when called from organizations policies that check
-- org_members (which has its own self-referencing RLS policies).
-- Fix: SECURITY DEFINER with search_path = public (Constitution 1.4).
-- ROLLBACK: See original definitions in 0087_org_members.sql (SECURITY INVOKER)

CREATE OR REPLACE FUNCTION is_org_admin_of(target_org_id uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = auth.uid()
    AND org_id = target_org_id
    AND role IN ('owner', 'admin')
  );
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE;

CREATE OR REPLACE FUNCTION get_user_org_ids()
RETURNS SETOF uuid AS $$
  SELECT org_id FROM org_members WHERE user_id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE;
