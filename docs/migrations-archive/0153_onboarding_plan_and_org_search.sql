-- Migration: 0153_onboarding_plan_and_org_search.sql
-- Description: Add RPCs for onboarding plan selection and organization search.
-- 1. set_onboarding_plan: SECURITY DEFINER function to set subscription_tier
--    (bypasses protect_privileged_profile_fields trigger safely)
-- 2. search_organizations_public: SECURITY DEFINER function for org search
--    during onboarding (authenticated users can't see orgs via RLS)
-- 3. RLS policy: allow authenticated users to SELECT organizations
--
-- ROLLBACK: DROP FUNCTION IF EXISTS set_onboarding_plan(text);
--           DROP FUNCTION IF EXISTS search_organizations_public(text);
--           DROP POLICY IF EXISTS organizations_select_authenticated ON organizations;

-- =============================================================================
-- 1. set_onboarding_plan — safely update subscription_tier during onboarding
-- =============================================================================

CREATE OR REPLACE FUNCTION set_onboarding_plan(p_tier text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_valid_tiers text[] := ARRAY['free', 'starter', 'professional', 'enterprise'];
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Validate tier value
  IF NOT (p_tier = ANY(v_valid_tiers)) THEN
    RAISE EXCEPTION 'Invalid subscription tier: %. Valid tiers: free, starter, professional, enterprise', p_tier
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Update subscription_tier (SECURITY DEFINER bypasses the trigger)
  UPDATE profiles SET subscription_tier = p_tier WHERE id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'no_data_found';
  END IF;

  RETURN jsonb_build_object('success', true, 'tier', p_tier);
END;
$$;

GRANT EXECUTE ON FUNCTION set_onboarding_plan(text) TO authenticated;
COMMENT ON FUNCTION set_onboarding_plan IS 'Set subscription tier during onboarding. Validates tier value and runs as SECURITY DEFINER to bypass the protect_privileged_profile_fields trigger.';

-- =============================================================================
-- 2. search_organizations_public — parameterized org search for onboarding
-- =============================================================================

CREATE OR REPLACE FUNCTION search_organizations_public(p_query text)
RETURNS TABLE(id uuid, display_name text, domain text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_query text;
BEGIN
  -- Sanitize: escape LIKE wildcards
  v_query := '%' || replace(replace(replace(p_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  RETURN QUERY
    SELECT o.id, o.display_name, o.domain
    FROM organizations o
    WHERE o.display_name ILIKE v_query OR o.domain ILIKE v_query
    LIMIT 5;
END;
$$;

GRANT EXECUTE ON FUNCTION search_organizations_public(text) TO authenticated;
COMMENT ON FUNCTION search_organizations_public IS 'Search organizations by name or domain during onboarding. Returns up to 5 matches. SECURITY DEFINER to bypass RLS that restricts org visibility to members.';

-- =============================================================================
-- 3. RLS: allow authenticated users to view organizations (basic info)
-- =============================================================================
-- The anon role already has organizations_select_public (USING true).
-- Authenticated users need the same for onboarding org search fallback.

CREATE POLICY organizations_select_authenticated ON organizations
  FOR SELECT TO authenticated
  USING (true);

COMMENT ON POLICY organizations_select_authenticated ON organizations IS 'Allow authenticated users to view organizations (needed for onboarding org search). Mirrors the anon organizations_select_public policy.';
