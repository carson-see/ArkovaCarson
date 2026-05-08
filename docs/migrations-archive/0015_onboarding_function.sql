-- Migration: 0015_onboarding_function.sql
-- Description: Transactional onboarding function for role assignment and org creation
-- Rollback: DROP FUNCTION IF EXISTS update_profile_onboarding(user_role, text, text, text);

-- =============================================================================
-- TRANSACTIONAL ONBOARDING FUNCTION
-- =============================================================================
-- This function handles the atomic assignment of:
-- 1. User role (INDIVIDUAL or ORG_ADMIN)
-- 2. Organization creation (for ORG_ADMIN only)
-- 3. Audit event emission
--
-- Security: SECURITY DEFINER runs with owner privileges but validates auth.uid()
-- Idempotency: Returns success if role already set (no error)

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
  -- Get the authenticated user
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Get current role
  SELECT role INTO v_current_role
  FROM profiles
  WHERE id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Check if role is already set (idempotency)
  IF v_current_role IS NOT NULL THEN
    -- Return success with existing role (idempotent behavior)
    v_result := jsonb_build_object(
      'success', true,
      'role', v_current_role::text,
      'already_set', true,
      'user_id', v_user_id
    );

    -- If ORG_ADMIN, include org_id
    IF v_current_role = 'ORG_ADMIN' THEN
      SELECT org_id INTO v_org_id
      FROM profiles
      WHERE id = v_user_id;

      v_result := v_result || jsonb_build_object('org_id', v_org_id);
    END IF;

    RETURN v_result;
  END IF;

  -- Validate ORG_ADMIN requires org details
  IF p_role = 'ORG_ADMIN' THEN
    IF p_org_legal_name IS NULL OR p_org_legal_name = '' THEN
      RAISE EXCEPTION 'Organization legal name is required for ORG_ADMIN'
        USING ERRCODE = 'check_violation';
    END IF;

    IF p_org_display_name IS NULL OR p_org_display_name = '' THEN
      p_org_display_name := p_org_legal_name;
    END IF;

    -- Create organization
    INSERT INTO organizations (legal_name, display_name, domain, verification_status)
    VALUES (p_org_legal_name, p_org_display_name, p_org_domain, 'UNVERIFIED')
    RETURNING id INTO v_org_id;

    -- Emit ORG_CREATED audit event
    INSERT INTO audit_events (event_type, event_category, actor_id, target_type, target_id, org_id, details)
    VALUES (
      'org.created',
      'ORG',
      v_user_id,
      'organization',
      v_org_id,
      v_org_id,
      format('Organization created: %s', p_org_display_name)
    );

    -- Update profile with role and org_id
    -- Note: This bypasses the trigger because we're using SECURITY DEFINER
    UPDATE profiles
    SET
      role = p_role,
      role_set_at = now(),
      org_id = v_org_id
    WHERE id = v_user_id;

  ELSE
    -- INDIVIDUAL: Just set the role
    UPDATE profiles
    SET
      role = p_role,
      role_set_at = now()
    WHERE id = v_user_id;
  END IF;

  -- Emit ROLE_SET audit event
  INSERT INTO audit_events (event_type, event_category, actor_id, target_type, target_id, org_id, details)
  VALUES (
    'profile.role_set',
    'PROFILE',
    v_user_id,
    'profile',
    v_user_id,
    v_org_id,
    format('Role set to %s', p_role::text)
  );

  -- Build result
  v_result := jsonb_build_object(
    'success', true,
    'role', p_role::text,
    'already_set', false,
    'user_id', v_user_id
  );

  IF v_org_id IS NOT NULL THEN
    v_result := v_result || jsonb_build_object('org_id', v_org_id);
  END IF;

  RETURN v_result;
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION update_profile_onboarding(user_role, text, text, text) TO authenticated;

-- Comments
COMMENT ON FUNCTION update_profile_onboarding IS 'Transactional onboarding: sets role and creates org atomically. Idempotent - returns success if already set.';
