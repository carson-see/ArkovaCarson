-- =============================================================================
-- Migration 0110: Add add_org_member RPC function
-- Story: feat/add-existing-member-to-org — Allow org admins to add existing
--        platform users to their organization
-- Date: 2026-03-26
--
-- PURPOSE
-- -------
-- SECURITY DEFINER function that validates the caller is an org admin before
-- inserting into org_members and updating the target user's profile.
-- Constitution 1.4: Privileged DB operations must be server-side RPCs.
-- =============================================================================

CREATE OR REPLACE FUNCTION add_org_member(
  p_user_id uuid,
  p_org_id uuid,
  p_role text DEFAULT 'INDIVIDUAL'
)
RETURNS void AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_caller_is_admin boolean;
  v_target_exists boolean;
  v_already_member boolean;
BEGIN
  -- Validate role
  IF p_role NOT IN ('INDIVIDUAL', 'ORG_ADMIN') THEN
    RAISE EXCEPTION 'Invalid role: %. Must be INDIVIDUAL or ORG_ADMIN', p_role;
  END IF;

  -- Verify caller is an org admin
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = v_caller_id
    AND org_id = p_org_id
    AND role IN ('owner', 'admin')
  ) INTO v_caller_is_admin;

  IF NOT v_caller_is_admin THEN
    RAISE EXCEPTION 'insufficient_privilege: Only org admins can add members';
  END IF;

  -- Verify target user exists
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_user_id
  ) INTO v_target_exists;

  IF NOT v_target_exists THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  -- Check not already a member
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = p_user_id AND org_id = p_org_id
  ) INTO v_already_member;

  IF v_already_member THEN
    RAISE EXCEPTION 'User is already a member of this organization';
  END IF;

  -- Insert membership
  INSERT INTO org_members (user_id, org_id, role)
  VALUES (p_user_id, p_org_id, p_role);

  -- Update profile org_id if not already set
  UPDATE profiles
  SET org_id = p_org_id, role = p_role
  WHERE id = p_user_id AND org_id IS NULL;

  -- Audit event
  INSERT INTO audit_events (event_type, event_category, actor_id, org_id, target_type, target_id, details)
  VALUES (
    'MEMBER_ADDED',
    'ORGANIZATION',
    v_caller_id,
    p_org_id,
    'user',
    p_user_id::text,
    jsonb_build_object('role', p_role, 'added_by', v_caller_id)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Grant execute to authenticated users (RPC access)
GRANT EXECUTE ON FUNCTION add_org_member(uuid, uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- DROP FUNCTION IF EXISTS add_org_member(uuid, uuid, text);
