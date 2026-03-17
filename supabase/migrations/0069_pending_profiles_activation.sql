-- =============================================================================
-- Migration 0069: Pending profiles + activation tokens (BETA-04)
-- Story: BETA-04 (Auto-Create User on Admin Upload)
-- Date: 2026-03-17
--
-- PURPOSE
-- -------
-- When an org admin uploads a credential for a new person (who doesn't have
-- an Arkova account), the system needs to:
-- 1. Create a "pending" profile entry with an activation token
-- 2. Associate the credential (anchor) with that pending profile
-- 3. Send an activation email so the recipient can set up their account
--
-- CHANGES
-- -------
-- 1. Add profile_status enum (ACTIVE, PENDING_ACTIVATION, DEACTIVATED)
-- 2. Add status column to profiles (default ACTIVE for existing users)
-- 3. Add activation_token column (nullable, unique, expires after 7 days)
-- 4. Add activation_token_expires_at column
-- 5. Add recipient_email column to anchors (for pending recipients)
-- 6. Create create_pending_recipient() RPC
-- 7. Create activate_user() RPC
-- 8. RLS policies for pending profiles
-- =============================================================================

-- 1. Profile status enum
DO $$ BEGIN
  CREATE TYPE profile_status AS ENUM ('ACTIVE', 'PENDING_ACTIVATION', 'DEACTIVATED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2. Add status column to profiles
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS status profile_status DEFAULT 'ACTIVE';

COMMENT ON COLUMN profiles.status IS 'Profile lifecycle status: ACTIVE (normal), PENDING_ACTIVATION (created by admin, awaiting recipient activation), DEACTIVATED (soft-disabled)';

-- 3. Add activation token columns
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS activation_token TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS activation_token_expires_at TIMESTAMPTZ;

COMMENT ON COLUMN profiles.activation_token IS 'One-time activation token for pending profiles (hex, 64 chars). Cleared on activation.';
COMMENT ON COLUMN profiles.activation_token_expires_at IS 'Expiry for activation token (7 days from creation)';

-- 4. Add recipient_email to anchors (for admin-created anchors targeting a non-existing user)
ALTER TABLE anchors
  ADD COLUMN IF NOT EXISTS recipient_email TEXT;

COMMENT ON COLUMN anchors.recipient_email IS 'Email of the intended recipient (set by admin during credential issuance, used for pending profile creation)';

-- 5. Index for activation token lookup
CREATE INDEX IF NOT EXISTS idx_profiles_activation_token
  ON profiles (activation_token) WHERE activation_token IS NOT NULL;

-- 6. create_pending_recipient() RPC
-- Called by org admin to create a pending profile for a new recipient.
-- Returns the new profile's user_id (UUID).
CREATE OR REPLACE FUNCTION create_pending_recipient(
  p_email TEXT,
  p_org_id UUID,
  p_full_name TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  caller_profile RECORD;
  existing_profile RECORD;
  new_id UUID;
  token TEXT;
BEGIN
  -- Verify caller is ORG_ADMIN
  SELECT * INTO caller_profile
  FROM profiles
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found'
      USING ERRCODE = 'P0001';
  END IF;

  IF caller_profile.role != 'ORG_ADMIN' THEN
    RAISE EXCEPTION 'Only organization administrators can create pending recipients'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Verify caller belongs to the specified org
  IF caller_profile.org_id IS NULL OR caller_profile.org_id != p_org_id THEN
    RAISE EXCEPTION 'Cannot create recipients for a different organization'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Check if a profile with this email already exists
  SELECT id INTO existing_profile
  FROM profiles
  WHERE email = lower(trim(p_email));

  IF FOUND THEN
    RETURN existing_profile.id;
  END IF;

  -- Generate a secure activation token (64 hex chars = 32 bytes)
  token := encode(gen_random_bytes(32), 'hex');
  new_id := gen_random_uuid();

  -- Create the pending profile
  INSERT INTO profiles (
    id,
    email,
    full_name,
    org_id,
    role,
    status,
    activation_token,
    activation_token_expires_at,
    created_at,
    updated_at
  ) VALUES (
    new_id,
    lower(trim(p_email)),
    p_full_name,
    p_org_id,
    'MEMBER',
    'PENDING_ACTIVATION',
    token,
    now() + interval '7 days',
    now(),
    now()
  );

  -- Audit event
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
    'USER_INVITED',
    'USER',
    auth.uid(),
    caller_profile.email,
    p_org_id,
    'profile',
    new_id::text,
    jsonb_build_object(
      'recipient_email', lower(trim(p_email)),
      'invited_by', caller_profile.email
    )::text
  );

  RETURN new_id;
END;
$$;

-- 7. activate_user() RPC
-- Called by the recipient when they click the activation link.
-- Validates the token, creates the Supabase auth user, and activates the profile.
-- NOTE: This RPC is called without auth context (anon key) since the user
-- doesn't have a Supabase auth account yet. The activation token serves as
-- the authentication mechanism.
CREATE OR REPLACE FUNCTION activate_user(
  p_token TEXT,
  p_password TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  pending_profile RECORD;
BEGIN
  -- Look up the pending profile by activation token
  SELECT * INTO pending_profile
  FROM profiles
  WHERE activation_token = p_token
    AND status = 'PENDING_ACTIVATION';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid or expired activation token');
  END IF;

  -- Check if token has expired
  IF pending_profile.activation_token_expires_at < now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Activation token has expired. Please contact your organization administrator.');
  END IF;

  -- Activate the profile: clear token, set status to ACTIVE
  UPDATE profiles
  SET status = 'ACTIVE',
      activation_token = NULL,
      activation_token_expires_at = NULL,
      updated_at = now()
  WHERE id = pending_profile.id;

  -- Audit event
  INSERT INTO audit_events (
    event_type,
    event_category,
    actor_id,
    org_id,
    target_type,
    target_id,
    details
  ) VALUES (
    'USER_ACTIVATED',
    'USER',
    pending_profile.id,
    pending_profile.org_id,
    'profile',
    pending_profile.id::text,
    jsonb_build_object('email', pending_profile.email)::text
  );

  RETURN jsonb_build_object(
    'success', true,
    'email', pending_profile.email,
    'profile_id', pending_profile.id
  );
END;
$$;

-- 8. Grant execute to authenticated + anon (activate_user needs anon)
GRANT EXECUTE ON FUNCTION create_pending_recipient(TEXT, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION activate_user(TEXT, TEXT) TO authenticated, anon;

-- =============================================================================
-- ROLLBACK
-- =============================================================================
-- ALTER TABLE profiles DROP COLUMN IF EXISTS status;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS activation_token;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS activation_token_expires_at;
-- ALTER TABLE anchors DROP COLUMN IF EXISTS recipient_email;
-- DROP INDEX IF EXISTS idx_profiles_activation_token;
-- DROP FUNCTION IF EXISTS create_pending_recipient(TEXT, UUID, TEXT);
-- DROP FUNCTION IF EXISTS activate_user(TEXT, TEXT);
-- DROP TYPE IF EXISTS profile_status;
