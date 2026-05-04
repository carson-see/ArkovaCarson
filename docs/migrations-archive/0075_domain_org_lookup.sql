-- Migration: 0075_domain_org_lookup.sql
-- Description: Add RPC to look up organization by email domain for auto-association at signup
-- ROLLBACK: DROP FUNCTION IF EXISTS lookup_org_by_email_domain(text);
--           DROP FUNCTION IF EXISTS join_org_by_domain(uuid);

-- =============================================================================
-- LOOKUP ORG BY EMAIL DOMAIN
-- =============================================================================
-- Public function that takes an email address and returns matching org info
-- if the email domain matches an organization's registered domain.
-- Used during onboarding to suggest org association.

CREATE OR REPLACE FUNCTION lookup_org_by_email_domain(p_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_email text;
  v_domain text;
  v_org_id uuid;
  v_org_name text;
  v_org_display_name text;
BEGIN
  -- Security: verify p_email matches the authenticated caller's email
  -- Prevents org enumeration by probing arbitrary domains
  SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();

  IF v_caller_email IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  IF lower(p_email) != lower(v_caller_email) THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  -- Extract domain from the verified email
  v_domain := lower(split_part(p_email, '@', 2));

  IF v_domain = '' OR v_domain IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  -- Look up organization by domain
  SELECT id, legal_name, display_name
  INTO v_org_id, v_org_name, v_org_display_name
  FROM organizations
  WHERE lower(domain) = v_domain
    AND deleted_at IS NULL
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'org_id', v_org_id,
    'org_name', COALESCE(v_org_display_name, v_org_name),
    'domain', v_domain
  );
END;
$$;

-- =============================================================================
-- JOIN ORG BY DOMAIN
-- =============================================================================
-- Called during onboarding when a user confirms they want to join a domain-matched org.
-- Sets role to ORG_MEMBER and associates with the org.

CREATE OR REPLACE FUNCTION join_org_by_domain(p_org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_user_email text;
  v_user_domain text;
  v_org_domain text;
  v_current_role user_role;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Get user email from auth
  SELECT email INTO v_user_email
  FROM auth.users
  WHERE id = v_user_id;

  v_user_domain := lower(split_part(v_user_email, '@', 2));

  -- Verify org exists and domain matches
  SELECT lower(domain) INTO v_org_domain
  FROM organizations
  WHERE id = p_org_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_org_domain IS NULL OR v_org_domain != v_user_domain THEN
    RAISE EXCEPTION 'Email domain does not match organization domain'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Check role not already set
  SELECT role INTO v_current_role
  FROM profiles
  WHERE id = v_user_id;

  IF v_current_role IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_set', true,
      'role', v_current_role::text,
      'user_id', v_user_id
    );
  END IF;

  -- Set role to ORG_MEMBER and associate with org
  UPDATE profiles
  SET
    role = 'ORG_MEMBER',
    role_set_at = now(),
    org_id = p_org_id
  WHERE id = v_user_id;

  -- Audit event
  INSERT INTO audit_events (event_type, event_category, actor_id, target_type, target_id, org_id, details)
  VALUES (
    'profile.role_set',
    'PROFILE',
    v_user_id,
    'profile',
    v_user_id,
    p_org_id,
    format('Auto-joined org by domain match (%s)', v_user_domain)
  );

  RETURN jsonb_build_object(
    'success', true,
    'already_set', false,
    'role', 'ORG_MEMBER',
    'user_id', v_user_id,
    'org_id', p_org_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION lookup_org_by_email_domain(text) TO authenticated;
GRANT EXECUTE ON FUNCTION join_org_by_domain(uuid) TO authenticated;

COMMENT ON FUNCTION lookup_org_by_email_domain IS 'Look up organization by email domain for auto-association during onboarding';
COMMENT ON FUNCTION join_org_by_domain IS 'Join an organization by domain match during onboarding. Verifies email domain matches org domain.';
