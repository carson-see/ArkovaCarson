-- =============================================================================
-- Migration 0038: Fix circular RLS recursion on profiles
-- Date: 2026-03-09
--
-- PURPOSE
-- -------
-- Migration 0035 added profiles_select_org_members RLS policy which calls
-- get_user_org_id(). That function queries the profiles table, triggering
-- RLS evaluation again, which calls get_user_org_id() again — infinite
-- recursion causing error 54001 (max_stack_depth exceeded).
--
-- FIX: Make get_user_org_id() and is_org_admin() SECURITY DEFINER so they
-- bypass RLS when querying the profiles table.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. get_user_org_id() — now SECURITY DEFINER to avoid RLS recursion
-- ---------------------------------------------------------------------------
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
-- 2. is_org_admin() — also SECURITY DEFINER for same reason
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_org_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
    AND role = 'ORG_ADMIN'
  );
$$;


-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE FUNCTION get_user_org_id()
-- RETURNS uuid
-- LANGUAGE sql
-- STABLE
-- AS $$
--   SELECT org_id FROM profiles WHERE id = auth.uid();
-- $$;
--
-- CREATE OR REPLACE FUNCTION is_org_admin()
-- RETURNS boolean
-- LANGUAGE sql
-- STABLE
-- AS $$
--   SELECT EXISTS (
--     SELECT 1 FROM profiles
--     WHERE id = auth.uid()
--     AND role = 'ORG_ADMIN'
--   );
-- $$;
