-- Migration: 0023_activate_user_function.sql
-- Description: activate_user RPC - links a pending invitation token to a user account
--              and stores their SHA-256 recovery phrase claim key.
-- Rollback: DROP TABLE IF EXISTS activation_tokens;
--           DROP FUNCTION IF EXISTS activate_user(text, text);

-- =============================================================================
-- ACTIVATION TOKENS TABLE
-- =============================================================================
-- Stores one-time invitation tokens sent via email. Tokens are consumed on use.

CREATE TABLE IF NOT EXISTS activation_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token       text UNIQUE NOT NULL,
  email       text NOT NULL,
  org_id      uuid NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role        user_role NOT NULL DEFAULT 'INDIVIDUAL',
  claim_key   text NULL,         -- SHA-256 of recovery phrase, set after activation
  used_at     timestamptz NULL,
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT activation_tokens_email_format CHECK (email ~ '^[^@]+@[^@]+\.[^@]+$'),
  CONSTRAINT activation_tokens_claim_key_length CHECK (
    claim_key IS NULL OR char_length(claim_key) = 64
  )
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_activation_tokens_token  ON activation_tokens(token);
CREATE INDEX IF NOT EXISTS idx_activation_tokens_email  ON activation_tokens(email);

-- RLS
ALTER TABLE activation_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE activation_tokens FORCE ROW LEVEL SECURITY;

-- No direct client reads — all access via SECURITY DEFINER function
REVOKE ALL ON activation_tokens FROM anon, authenticated;

-- =============================================================================
-- ACTIVATE USER FUNCTION
-- =============================================================================
-- Called from /activate?token=xxx page after user sets password via Supabase auth.
-- 1. Validates token (not expired, not used)
-- 2. Sets claim_key on the token row
-- 3. Updates the caller's profile role / org_id
-- 4. Marks token as used
-- 5. Emits audit event

CREATE OR REPLACE FUNCTION activate_user(
  p_token    text,
  p_claim_key text  -- SHA-256 hex of recovery phrase (64 chars)
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token   activation_tokens%ROWTYPE;
  v_profile profiles%ROWTYPE;
BEGIN
  -- Validate claim key format
  IF p_claim_key IS NULL OR char_length(p_claim_key) != 64 OR p_claim_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid claim key format'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Look up token
  SELECT * INTO v_token
  FROM activation_tokens
  WHERE token = p_token
    AND used_at IS NULL
    AND expires_at > now();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid or expired activation token'
      USING ERRCODE = 'P0001';
  END IF;

  -- Ensure caller is authenticated
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Must be authenticated to activate account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Get caller profile
  SELECT * INTO v_profile
  FROM profiles
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found'
      USING ERRCODE = 'P0001';
  END IF;

  -- Mark token used + store claim key
  UPDATE activation_tokens
  SET used_at  = now(),
      claim_key = p_claim_key
  WHERE id = v_token.id;

  -- Update profile role / org if specified by token
  UPDATE profiles
  SET role       = COALESCE(v_token.role, role),
      org_id     = COALESCE(v_token.org_id, org_id),
      role_set_at = CASE WHEN role IS NULL THEN now() ELSE role_set_at END,
      updated_at  = now()
  WHERE id = auth.uid();

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
    'USER_ACTIVATED',
    'AUTH',
    auth.uid(),
    v_profile.email,
    v_token.org_id,
    'profile',
    auth.uid()::text,
    jsonb_build_object(
      'token_id', v_token.id,
      'assigned_role', v_token.role
    )::text
  );

  RETURN jsonb_build_object('success', true, 'role', v_token.role);
END;
$$;

GRANT EXECUTE ON FUNCTION activate_user(text, text) TO authenticated;

COMMENT ON TABLE  activation_tokens IS 'One-time invitation / activation tokens sent via email';
COMMENT ON FUNCTION activate_user(text, text) IS 'Activates a user account by consuming an invitation token and storing a SHA-256 recovery phrase claim key';
