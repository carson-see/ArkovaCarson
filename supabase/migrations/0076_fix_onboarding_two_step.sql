-- Migration: 0076_fix_onboarding_two_step.sql
-- Description: Fix update_profile_onboarding to support two-step org onboarding.
--   Step 1: User selects ORG_ADMIN role (no org details yet)
--   Step 2: User creates org on the next page (calls with org details)
-- Previously the RPC required org details when role=ORG_ADMIN, blocking the two-step flow.
--
-- ROLLBACK: Re-apply 0015_onboarding_function.sql

CREATE OR REPLACE FUNCTION update_profile_onboarding(
  p_role user_role,
  p_org_legal_name text DEFAULT NULL,
  p_org_display_name text DEFAULT NULL,
  p_org_domain text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_current_role user_role;
  v_org_id uuid;
  v_result jsonb;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT role INTO v_current_role FROM profiles WHERE id = v_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'no_data_found';
  END IF;

  -- Idempotency: if role already set, return success
  IF v_current_role IS NOT NULL THEN
    v_result := jsonb_build_object(
      'success', true, 'role', v_current_role::text,
      'already_set', true, 'user_id', v_user_id
    );
    IF v_current_role = 'ORG_ADMIN' THEN
      SELECT org_id INTO v_org_id FROM profiles WHERE id = v_user_id;
      v_result := v_result || jsonb_build_object('org_id', v_org_id);
    END IF;
    RETURN v_result;
  END IF;

  -- ORG_ADMIN with org details: create org + set role atomically (single-step)
  IF p_role = 'ORG_ADMIN' AND p_org_legal_name IS NOT NULL AND p_org_legal_name != '' THEN
    IF p_org_display_name IS NULL OR p_org_display_name = '' THEN
      p_org_display_name := p_org_legal_name;
    END IF;

    INSERT INTO organizations (legal_name, display_name, domain, verification_status)
    VALUES (p_org_legal_name, p_org_display_name, p_org_domain, 'UNVERIFIED')
    RETURNING id INTO v_org_id;

    INSERT INTO audit_events (event_type, event_category, actor_id, target_type, target_id, org_id, details)
    VALUES ('org.created', 'ORG', v_user_id, 'organization', v_org_id, v_org_id,
            format('Organization created: %s', p_org_display_name));

    UPDATE profiles SET role = p_role, role_set_at = now(), org_id = v_org_id WHERE id = v_user_id;
  ELSE
    -- INDIVIDUAL: just set role
    -- ORG_ADMIN without org details: set role only (step 1 of two-step flow)
    --   useProfile destination will be /onboarding/org, RouteGuard redirects there
    UPDATE profiles SET role = p_role, role_set_at = now() WHERE id = v_user_id;
  END IF;

  -- Audit event
  INSERT INTO audit_events (event_type, event_category, actor_id, target_type, target_id, org_id, details)
  VALUES ('profile.role_set', 'PROFILE', v_user_id, 'profile', v_user_id, v_org_id,
          format('Role set to %s', p_role::text));

  v_result := jsonb_build_object(
    'success', true, 'role', p_role::text,
    'already_set', false, 'user_id', v_user_id
  );
  IF v_org_id IS NOT NULL THEN
    v_result := v_result || jsonb_build_object('org_id', v_org_id);
  END IF;
  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION update_profile_onboarding(user_role, text, text, text) TO authenticated;
