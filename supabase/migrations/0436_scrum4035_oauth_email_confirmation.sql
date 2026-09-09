-- SCRUM-4035 / UAT-03: Arkova mailbox proof after new OAuth signup.
-- Deployment: leave enabled_at NULL until app/worker/edge and the Auth hook
-- are installed and verified. Then activate with server time, not a past cutoff.
-- ROLLBACK: disable NEW enrollment by setting enabled_at=NULL. Retain the hook,
-- pending role, worker/edge pending-role denials, and confirmation endpoint for
-- existing pending accounts. Reverting to a worker that accepts pending JWTs
-- through getUser is unsafe. Removing
-- these structures before those accounts are resolved would grant access or lock
-- users out; a destructive rollback is not safe. No production activation here.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='arkova_email_pending') THEN
    CREATE ROLE arkova_email_pending NOLOGIN NOINHERIT;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='arkova_email_pending'
    AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolinherit OR rolcreaterole OR rolcreatedb OR rolreplication)) THEN
    RAISE EXCEPTION 'Pending email role must have no elevated role attributes';
  END IF;
  -- PostgreSQL 16+ automatically gives a non-superuser creator ADMIN membership,
  -- granted by the bootstrap superuser, with SET/INHERIT both false. Supabase's
  -- postgres migration principal receives this grant. It cannot assume the role.
  -- Permit only that administration-only grant to this trusted migration principal.
  -- JSON catalog access keeps PG15 compatibility; absent option fields fail closed.
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles r ON r.oid=m.roleid
    JOIN pg_roles member_role ON member_role.oid=m.member
    JOIN pg_roles grantor_role ON grantor_role.oid=m.grantor
    WHERE r.rolname='arkova_email_pending'
      AND NOT (member_role.rolname=current_user AND member_role.rolcreaterole
        AND member_role.rolbypassrls AND grantor_role.rolsuper AND m.admin_option
        AND (to_jsonb(m)->>'set_option')::boolean IS FALSE
        AND (to_jsonb(m)->>'inherit_option')::boolean IS FALSE)
  ) THEN
    RAISE EXCEPTION 'Pending email role must have no runtime members';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
    WHERE r.rolname='arkova_email_pending') THEN
    RAISE EXCEPTION 'Pending email role must have no parent roles';
  END IF;
END $$;
-- Intentionally NO GRANT arkova_email_pending TO authenticator. This prevents
-- SET ROLE before any Data API/RPC request, including PUBLIC SECURITY DEFINERs.

CREATE TABLE private.oauth_email_confirmation_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled_at timestamptz
);
INSERT INTO private.oauth_email_confirmation_policy(singleton,enabled_at) VALUES (true,NULL);
ALTER TABLE private.oauth_email_confirmation_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.oauth_email_confirmation_policy FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.oauth_email_confirmation_policy FROM PUBLIC,anon,authenticated;

CREATE TABLE private.oauth_email_confirmations (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  attempt_id uuid,
  attempted_at timestamptz,
  challenge_digest text UNIQUE CHECK (challenge_digest ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz,
  sent_at timestamptz
);
ALTER TABLE private.oauth_email_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.oauth_email_confirmations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.oauth_email_confirmations FROM PUBLIC,anon,authenticated;

CREATE FUNCTION private.requires_oauth_email_confirmation(p_user_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_confirmed timestamptz;
BEGIN
  SELECT confirmed_at INTO v_confirmed FROM private.oauth_email_confirmations WHERE user_id=p_user_id;
  IF FOUND THEN RETURN v_confirmed IS NULL; END IF;
  -- Same cohort predicate as the early enrollment trigger. This fails closed
  -- even if an auth trigger invokes domain association before enrollment exists.
  RETURN EXISTS (
    SELECT 1 FROM auth.users u CROSS JOIN private.oauth_email_confirmation_policy p
    WHERE u.id=p_user_id AND p.enabled_at IS NOT NULL AND u.created_at>=p.enabled_at
      AND u.raw_app_meta_data->>'provider' IN ('google','linkedin_oidc')
  );
END $$;
REVOKE ALL ON FUNCTION private.requires_oauth_email_confirmation(uuid) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION private.enroll_oauth_email_confirmation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_existing_mailbox_proof timestamptz;
BEGIN
  IF NEW.raw_app_meta_data->>'provider' IN ('google','linkedin_oidc')
     AND EXISTS (SELECT 1 FROM private.oauth_email_confirmation_policy WHERE enabled_at IS NOT NULL AND NEW.created_at>=enabled_at) THEN
    -- A previously confirmed email account can link/unlink providers without
    -- repeating signup. An UNCONFIRMED email account converted by Google must
    -- enroll before GoTrue confirms it. Existing pending rows are never changed.
    IF TG_OP='UPDATE' AND OLD.raw_app_meta_data->>'provider'='email'
       AND OLD.email_confirmed_at IS NOT NULL AND lower(OLD.email)=lower(NEW.email) THEN
      v_existing_mailbox_proof := OLD.email_confirmed_at;
    END IF;
    INSERT INTO private.oauth_email_confirmations(user_id,email,confirmed_at)
    VALUES(NEW.id,lower(COALESCE(NEW.email,'')),v_existing_mailbox_proof)
    ON CONFLICT(user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.enroll_oauth_email_confirmation() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER aa_enroll_oauth_email_confirmation AFTER INSERT OR UPDATE OF raw_app_meta_data ON auth.users
FOR EACH ROW EXECUTE FUNCTION private.enroll_oauth_email_confirmation();

CREATE FUNCTION private.oauth_email_confirmation_token_hook(event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF private.requires_oauth_email_confirmation((event->>'user_id')::uuid) THEN
    RETURN jsonb_build_object('claims',jsonb_set(event->'claims','{role}','"arkova_email_pending"'::jsonb));
  END IF;
  RETURN event;
END $$;
REVOKE ALL ON FUNCTION private.oauth_email_confirmation_token_hook(jsonb) FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA private TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION private.oauth_email_confirmation_token_hook(jsonb) TO supabase_auth_admin;

-- One service-only transaction boundary for the challenge lifecycle. Raw
-- token_hash is never stored; callers supply SHA-256(token_hash). The worker
-- must successfully verifyOtp(type='magiclink') before asking for complete.
CREATE FUNCTION public.manage_oauth_email_confirmation(
  p_action text, p_user_id uuid DEFAULT NULL, p_email text DEFAULT NULL,
  p_challenge_digest text DEFAULT NULL, p_attempt_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v private.oauth_email_confirmations%ROWTYPE;
  v_email text;
  v_retry integer;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_action='lookup' THEN
    SELECT * INTO v FROM private.oauth_email_confirmations
    WHERE challenge_digest=p_challenge_digest AND confirmed_at IS NULL AND expires_at>v_now;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','invalid_link'); END IF;
    RETURN jsonb_build_object('userId',v.user_id,'email',v.email);
  END IF;

  -- Lock auth identity FIRST in every mutating path. Email changes and final
  -- completion cannot race between a worker-side read and the proof write.
  SELECT lower(email) INTO v_email FROM auth.users WHERE id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','invalid_identity'); END IF;
  SELECT * INTO v FROM private.oauth_email_confirmations WHERE user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v.confirmed_at IS NOT NULL THEN
    IF p_action='complete' THEN RETURN jsonb_build_object('error','invalid_link'); END IF;
    RETURN jsonb_build_object('required',false);
  END IF;

  v_now := clock_timestamp(); -- refresh after lock waits; expiry uses consumption time
  v_retry:=greatest(0,ceil(extract(epoch FROM (v.attempted_at+interval '90 seconds'-v_now)))::integer);
  IF p_action='status' THEN
    RETURN jsonb_build_object('required',true,'sent',COALESCE(v.sent_at IS NOT NULL AND v.email=v_email AND v.expires_at>v_now,false),'retryAfterSeconds',v_retry);
  ELSIF p_action='claim' THEN
    IF v_retry>0 THEN RETURN jsonb_build_object('error','cooldown','retryAfterSeconds',v_retry); END IF;
    UPDATE private.oauth_email_confirmations SET email=v_email,attempt_id=gen_random_uuid(),attempted_at=v_now,
      challenge_digest=NULL,expires_at=NULL,sent_at=NULL WHERE user_id=p_user_id RETURNING * INTO v;
    RETURN jsonb_build_object('required',true,'email',v_email,'attemptId',v.attempt_id,'retryAfterSeconds',90);
  ELSIF p_action='register' THEN
    IF p_attempt_id IS DISTINCT FROM v.attempt_id OR lower(p_email) IS DISTINCT FROM v_email
       OR v.email IS DISTINCT FROM v_email OR v.attempted_at+interval '90 seconds'<=v_now
       OR p_challenge_digest IS NULL OR p_challenge_digest !~ '^[0-9a-f]{64}$' THEN
      RETURN jsonb_build_object('error','invalid_link');
    END IF;
    UPDATE private.oauth_email_confirmations SET challenge_digest=p_challenge_digest,expires_at=v_now+interval '15 minutes'
    WHERE user_id=p_user_id;
    RETURN jsonb_build_object('required',true);
  ELSIF p_action='sent' THEN
    IF p_attempt_id IS DISTINCT FROM v.attempt_id OR p_challenge_digest IS DISTINCT FROM v.challenge_digest THEN
      RETURN jsonb_build_object('error','invalid_link');
    END IF;
    UPDATE private.oauth_email_confirmations SET sent_at=v_now WHERE user_id=p_user_id;
    RETURN jsonb_build_object('required',true,'sent',true,'retryAfterSeconds',v_retry);
  ELSIF p_action='complete' THEN
    IF p_challenge_digest IS NULL OR p_challenge_digest IS DISTINCT FROM v.challenge_digest
       OR lower(p_email) IS DISTINCT FROM v_email OR v.email IS DISTINCT FROM v_email
       OR v.expires_at IS NULL OR v.expires_at<=v_now THEN
      RETURN jsonb_build_object('error','invalid_link');
    END IF;
    UPDATE private.oauth_email_confirmations SET confirmed_at=v_now,challenge_digest=NULL,expires_at=NULL
    WHERE user_id=p_user_id;
    PERFORM public.auto_associate_profile_to_org_by_email_domain(p_user_id,v_email);
    RETURN jsonb_build_object('required',false);
  END IF;
  RETURN jsonb_build_object('error','invalid_action');
END $$;
REVOKE ALL ON FUNCTION public.manage_oauth_email_confirmation(text,uuid,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.manage_oauth_email_confirmation(text,uuid,text,text,uuid) TO service_role;

-- Keep the existing helper contract; defer domain membership until mailbox proof.
CREATE OR REPLACE FUNCTION "public"."auto_associate_profile_to_org_by_email_domain"("p_user_id" "uuid", "p_email" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
DECLARE
  v_domain text;
  v_org_id uuid;
  v_org_name text;
  v_profile_exists boolean;
  v_membership_count integer;
BEGIN
  IF p_user_id IS NULL OR p_email IS NULL OR position('@' in p_email) = 0 THEN
    RETURN NULL;
  END IF;

  IF private.requires_oauth_email_confirmation(p_user_id) THEN
    RETURN NULL;
  END IF;

  v_domain := lower(split_part(p_email, '@', 2));
  IF v_domain IS NULL OR v_domain = '' THEN
    RETURN NULL;
  END IF;

  SELECT id, display_name
  INTO v_org_id, v_org_name
  FROM organizations
  WHERE lower(domain) = v_domain
  ORDER BY
    COALESCE(domain_verified, false) DESC,
    CASE verification_status
      WHEN 'VERIFIED' THEN 0
      WHEN 'PENDING' THEN 1
      ELSE 2
    END,
    created_at ASC
  LIMIT 1;

  IF v_org_id IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  INSERT INTO org_members (user_id, org_id, role)
  VALUES (p_user_id, v_org_id, 'member')
  ON CONFLICT (user_id, org_id) DO NOTHING;
  GET DIAGNOSTICS v_membership_count = ROW_COUNT;

  SELECT EXISTS (SELECT 1 FROM profiles WHERE id = p_user_id)
  INTO v_profile_exists;

  IF v_profile_exists THEN
    UPDATE profiles
    SET
      org_id = COALESCE(org_id, v_org_id),
      role = COALESCE(role, 'ORG_MEMBER'::user_role),
      role_set_at = CASE WHEN role IS NULL THEN now() ELSE role_set_at END
    WHERE id = p_user_id
      AND (org_id IS NULL OR role IS NULL);

    IF v_membership_count > 0 THEN
      INSERT INTO audit_events (
        event_type,
        event_category,
        actor_id,
        target_type,
        target_id,
        org_id,
        details
      ) VALUES (
        'profile.org_auto_associated',
        'PROFILE',
        p_user_id,
        'profile',
        p_user_id,
        v_org_id,
        format('Auto-associated %s to %s by verified email domain %s', p_email, v_org_name, v_domain)
      );
    END IF;
  END IF;

  RETURN v_org_id;
END;
$$;


-- Preserve the service-only ACL established by migration 0378 when redefining.
REVOKE ALL ON FUNCTION public.auto_associate_profile_to_org_by_email_domain(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.auto_associate_profile_to_org_by_email_domain(uuid,text) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
