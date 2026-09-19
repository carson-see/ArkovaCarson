-- UAT-23 follow-up: repair OUT-parameter ambiguity in recipient recovery.
--
-- Migration 0471 is already applied to B4 and remains immutable. Its TABLE
-- return column `activation_token` is also a PL/pgSQL variable, so the
-- unqualified UPDATE predicate `activation_token IS NULL` raises 42702 on the
-- production-shaped existing-profile recovery path. Replace only the function
-- body, qualifying the UPDATE target, fallback RHS, predicate, and RETURNING.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.recover_bulk_recipient_profile(
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
    UPDATE public.profiles AS p SET
      status = 'PENDING_ACTIVATION',
      activation_token = p_activation_token,
      activation_token_expires_at = p_activation_token_expires_at,
      full_name = COALESCE(NULLIF(btrim(p_full_name), ''), p.full_name)
    WHERE p.id = v_user.id AND p.activation_token IS NULL
    RETURNING p.* INTO v_profile;
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
