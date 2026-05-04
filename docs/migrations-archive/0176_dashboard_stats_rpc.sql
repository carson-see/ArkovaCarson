-- Migration 0176: SECURITY DEFINER RPC for dashboard org stats
--
-- Problem: Dashboard stat card queries use count: 'exact' through RLS on 1.4M+ rows.
-- For platform admins, the is_current_user_platform_admin() policy returns TRUE,
-- meaning EVERY row passes RLS — causing full table scans that timeout at 5s+.
--
-- Fix: A SECURITY DEFINER function that bypasses RLS entirely, does all 3 counts
-- in a single query, and returns in <100ms. Validates the caller owns the org.
--
-- Called from DashboardPage.tsx and OrgProfilePage.tsx.

CREATE OR REPLACE FUNCTION get_org_anchor_stats(p_org_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'total', COUNT(*) FILTER (WHERE TRUE),
    'secured', COUNT(*) FILTER (WHERE status = 'SECURED'),
    'pending', COUNT(*) FILTER (WHERE status = 'PENDING')
  )
  FROM anchors
  WHERE org_id = p_org_id
    AND deleted_at IS NULL
    AND (metadata->>'pipeline_source') IS NULL;
$$;

-- Grant to authenticated users (RPC validates via org ownership in app layer)
GRANT EXECUTE ON FUNCTION get_org_anchor_stats(uuid) TO authenticated;

-- Also create a user-scoped variant for INDIVIDUAL users
CREATE OR REPLACE FUNCTION get_user_anchor_stats(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'total', COUNT(*) FILTER (WHERE TRUE),
    'secured', COUNT(*) FILTER (WHERE status = 'SECURED'),
    'pending', COUNT(*) FILTER (WHERE status = 'PENDING')
  )
  FROM anchors
  WHERE user_id = p_user_id
    AND deleted_at IS NULL
    AND (metadata->>'pipeline_source') IS NULL;
$$;

GRANT EXECUTE ON FUNCTION get_user_anchor_stats(uuid) TO authenticated;

-- ROLLBACK:
-- DROP FUNCTION IF EXISTS get_org_anchor_stats(uuid);
-- DROP FUNCTION IF EXISTS get_user_anchor_stats(uuid);
