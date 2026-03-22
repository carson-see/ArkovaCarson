-- Migration: 0082_fix_org_onboarding_two_step.sql
-- Fix BUG-2.3: Org admin onboarding error
-- The two-step onboarding flow breaks because the idempotency check
-- returns early when role is already set (step 1), preventing org creation (step 2).
-- Fix: Allow the second call to proceed when role=ORG_ADMIN, org_id IS NULL,
-- and org details are provided.
--
-- ROLLBACK: Re-apply 0076_fix_onboarding_two_step.sql

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
  v_current_org_id uuid;
  v_org_id uuid;
  v_result jsonb;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT role, org_id INTO v_current_role, v_current_org_id FROM profiles WHERE id = v_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'no_data_found';
  END IF;

  -- Idempotency: if role already set AND we're not completing step 2 of org onboarding
  IF v_current_role IS NOT NULL THEN
    -- Allow step 2: role is ORG_ADMIN, org not yet created, and org details provided
    IF v_current_role = 'ORG_ADMIN' AND v_current_org_id IS NULL
       AND p_org_legal_name IS NOT NULL AND p_org_legal_name != '' THEN
      -- Fall through to org creation below
      NULL;
    ELSE
      -- Truly idempotent — role fully set up
      v_result := jsonb_build_object(
        'success', true, 'role', v_current_role::text,
        'already_set', true, 'user_id', v_user_id
      );
      IF v_current_role = 'ORG_ADMIN' THEN
        v_result := v_result || jsonb_build_object('org_id', v_current_org_id);
      END IF;
      RETURN v_result;
    END IF;
  END IF;

  -- ORG_ADMIN with org details: create org + set role atomically
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
