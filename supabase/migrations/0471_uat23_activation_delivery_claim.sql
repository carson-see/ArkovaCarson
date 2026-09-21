-- UAT-23: durable at-most-once automatic activation-email claim.
--
-- The bulk import route creates an unconfirmed auth user plus a pending,
-- org-less profile for a recipient who does not yet have an Arkova account.
-- Import replay must re-link the same profile without sending another
-- activation message. This PII-free receipt is inserted before the provider
-- call; its (profile_id, token_hash) primary key is the cross-replica arbiter.
-- A claimed delivery is never automatically reclaimed after an ambiguous
-- provider result: that preserves at-most-one provider attempt. Explicit
-- operator/user resend is a separately authorized recovery action.
--
-- SAFE ROLLBACK:
--   First disable the UAT-23 bulk activation-dispatch code and verify no worker
--   can send from it. Retain this table and its rows: dropping the durable
--   claims would let a later code rollback/replay send duplicate activation
--   email. Destructive table removal is intentionally NOT an ordinary rollback
--   step and requires a separately approved retention/deletion operation.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE public.recipient_activation_deliveries (
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'sending'
    CHECK (status IN ('sending', 'sent', 'failed')),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  failure_code text,
  PRIMARY KEY (profile_id, token_hash),
  CHECK (
    (status = 'sending' AND completed_at IS NULL AND failure_code IS NULL)
    OR (status = 'sent' AND completed_at IS NOT NULL AND failure_code IS NULL)
    OR (status = 'failed' AND completed_at IS NOT NULL AND failure_code IS NOT NULL)
  )
);

ALTER TABLE public.recipient_activation_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipient_activation_deliveries FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.recipient_activation_deliveries FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.recipient_activation_deliveries TO service_role;

COMMENT ON TABLE public.recipient_activation_deliveries IS
  'PII-free, at-most-once automatic activation-email claims for UAT-23 bulk recipient provisioning. Service role only.';

-- Recover the narrow crash window where Auth creation committed but the
-- trigger/profile write did not. Both app_metadata markers are server-only;
-- confirmed or ordinary accounts can never be adopted by this path.
CREATE FUNCTION public.recover_bulk_recipient_profile(
  p_email text,
  p_full_name text,
  p_activation_token text,
  p_activation_token_expires_at timestamptz,
  p_expected_user_id uuid DEFAULT NULL
) RETURNS TABLE(profile_id uuid, activation_token text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user auth.users%ROWTYPE;
  v_count integer;
  v_profile profiles%ROWTYPE;
  v_profile_exists boolean;
BEGIN
  IF public.get_caller_role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_email IS NULL OR btrim(p_email) = ''
      OR p_activation_token IS NULL OR p_activation_token !~ '^[a-f0-9]{64}$'
      OR p_activation_token_expires_at IS NULL OR p_activation_token_expires_at <= now() THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_count
  FROM auth.users u
  WHERE lower(u.email) = lower(btrim(p_email))
    AND (p_expected_user_id IS NULL OR u.id = p_expected_user_id)
    AND u.email_confirmed_at IS NULL
    AND u.raw_app_meta_data->>'arkova_bulk_recipient' = 'true'
    AND u.raw_app_meta_data->>'admin_provisioned' = 'true';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'recipient_recovery_forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO STRICT v_user
  FROM auth.users u
  WHERE lower(u.email) = lower(btrim(p_email))
    AND (p_expected_user_id IS NULL OR u.id = p_expected_user_id)
    AND u.email_confirmed_at IS NULL
    AND u.raw_app_meta_data->>'arkova_bulk_recipient' = 'true'
    AND u.raw_app_meta_data->>'admin_provisioned' = 'true'
  FOR UPDATE;

  IF EXISTS (SELECT 1 FROM org_members om WHERE om.user_id = v_user.id) THEN
    RAISE EXCEPTION 'recipient_recovery_conflict' USING ERRCODE = '23505';
  END IF;

  SELECT * INTO v_profile FROM profiles WHERE id = v_user.id FOR UPDATE;
  v_profile_exists := FOUND;
  -- Defense in depth after the profile lock: if membership committed while
  -- recovery was waiting on either FK-related identity lock, fail closed.
  IF EXISTS (SELECT 1 FROM org_members om WHERE om.user_id = v_user.id) THEN
    RAISE EXCEPTION 'recipient_recovery_conflict' USING ERRCODE = '23505';
  END IF;
  IF v_profile_exists THEN
    IF lower(v_profile.email) <> lower(btrim(p_email)) OR v_profile.org_id IS NOT NULL
        OR v_profile.role IS NOT NULL OR v_profile.deleted_at IS NOT NULL
        OR v_profile.status IS NULL
        OR v_profile.status NOT IN ('ACTIVE', 'PENDING_ACTIVATION') THEN
      RAISE EXCEPTION 'recipient_recovery_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_profile.status = 'PENDING_ACTIVATION' AND v_profile.activation_token IS NOT NULL THEN
      RETURN QUERY SELECT v_profile.id, v_profile.activation_token;
      RETURN;
    END IF;
    UPDATE profiles SET
      status = 'PENDING_ACTIVATION',
      activation_token = p_activation_token,
      activation_token_expires_at = p_activation_token_expires_at,
      full_name = COALESCE(NULLIF(btrim(p_full_name), ''), full_name)
    WHERE id = v_user.id AND activation_token IS NULL
    RETURNING * INTO v_profile;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'recipient_recovery_conflict' USING ERRCODE = '23505';
    END IF;
  ELSE
    INSERT INTO profiles (
      id, email, full_name, org_id, role, status,
      activation_token, activation_token_expires_at
    ) VALUES (
      v_user.id, lower(btrim(p_email)), NULLIF(btrim(p_full_name), ''), NULL, NULL,
      'PENDING_ACTIVATION', p_activation_token, p_activation_token_expires_at
    ) RETURNING * INTO v_profile;
  END IF;

  RETURN QUERY SELECT v_profile.id, v_profile.activation_token;
END;
$$;

REVOKE ALL ON FUNCTION public.recover_bulk_recipient_profile(text,text,text,timestamptz,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_bulk_recipient_profile(text,text,text,timestamptz,uuid)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
