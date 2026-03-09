-- Migration: 0025_fix_search_path_invite_member.sql
-- Description: Fix CV-04 — Add SET search_path to invite_member() SECURITY DEFINER function
-- Rollback: Re-run 0013_invite_member_function.sql (restores function without SET search_path)

-- Recreate invite_member() with SET search_path = public, pg_temp
CREATE OR REPLACE FUNCTION invite_member(
  invite_email text,
  invite_role user_role,
  org_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  caller_profile RECORD;
  existing_member RECORD;
  existing_invite RECORD;
  new_invite_id uuid;
BEGIN
  -- Validate email format
  IF invite_email !~ '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$' THEN
    RAISE EXCEPTION 'invalid email format'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Get the caller's profile
  SELECT * INTO caller_profile
  FROM profiles
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found'
      USING ERRCODE = 'P0001';
  END IF;

  -- Verify caller is ORG_ADMIN of the target org
  IF caller_profile.role != 'ORG_ADMIN' OR caller_profile.org_id != org_id THEN
    RAISE EXCEPTION 'Only organization administrators can invite members'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Check if email is already a member
  SELECT * INTO existing_member
  FROM profiles
  WHERE email = lower(invite_email)
  AND org_id = invite_member.org_id;

  IF FOUND THEN
    RAISE EXCEPTION 'User is already a member of this organization'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Check for existing pending invite
  SELECT * INTO existing_invite
  FROM invitations
  WHERE email = lower(invite_email)
  AND org_id = invite_member.org_id
  AND status = 'pending'
  AND expires_at > now();

  IF FOUND THEN
    RAISE EXCEPTION 'An invitation for this email is already pending'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Create the invitation
  INSERT INTO invitations (
    email,
    role,
    org_id,
    invited_by
  ) VALUES (
    lower(invite_email),
    invite_role,
    org_id,
    auth.uid()
  )
  RETURNING id INTO new_invite_id;

  -- Emit audit event
  INSERT INTO audit_events (
    event_type,
    event_category,
    actor_id,
    actor_email,
    org_id,
    target_type,
    target_id,
    details
  ) VALUES (
    'MEMBER_INVITED',
    'ORGANIZATION',
    auth.uid(),
    caller_profile.email,
    caller_profile.org_id,
    'invitation',
    new_invite_id::text,
    jsonb_build_object(
      'invited_email', lower(invite_email),
      'invited_role', invite_role
    )::text
  );

  RETURN new_invite_id;
END;
$$;
