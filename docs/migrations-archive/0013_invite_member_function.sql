-- Migration: 0013_invite_member_function.sql
-- Description: Function to invite members to an organization with audit logging
-- Rollback: DROP FUNCTION IF EXISTS invite_member(text, user_role, uuid);

-- Create invitations table if not exists
CREATE TABLE IF NOT EXISTS invitations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  email text NOT NULL,
  role user_role NOT NULL DEFAULT 'INDIVIDUAL',
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invited_by uuid NOT NULL REFERENCES profiles(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  token uuid DEFAULT uuid_generate_v4(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,

  CONSTRAINT unique_pending_invite UNIQUE (email, org_id, status)
);

-- Enable RLS on invitations
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;

-- RLS policies for invitations
DROP POLICY IF EXISTS "Org admins can view invitations" ON invitations;
CREATE POLICY "Org admins can view invitations" ON invitations
  FOR SELECT
  USING (
    org_id IN (
      SELECT org_id FROM profiles
      WHERE id = auth.uid() AND role = 'ORG_ADMIN'
    )
  );

DROP POLICY IF EXISTS "Org admins can create invitations" ON invitations;
CREATE POLICY "Org admins can create invitations" ON invitations
  FOR INSERT
  WITH CHECK (
    org_id IN (
      SELECT org_id FROM profiles
      WHERE id = auth.uid() AND role = 'ORG_ADMIN'
    )
  );

-- Function to invite a member to an organization
CREATE OR REPLACE FUNCTION invite_member(
  invite_email text,
  invite_role user_role,
  org_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
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

-- Grant execute to authenticated users (function enforces permissions internally)
GRANT EXECUTE ON FUNCTION invite_member(text, user_role, uuid) TO authenticated;

-- Comments
COMMENT ON TABLE invitations IS 'Pending member invitations for organizations';
COMMENT ON FUNCTION invite_member(text, user_role, uuid) IS 'Invites a new member to an organization. Only callable by org admins.';
