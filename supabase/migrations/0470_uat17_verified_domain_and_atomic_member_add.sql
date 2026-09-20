-- UAT-17: only an unambiguous, verified organization domain may claim a
-- confirmed signup. Also provide one atomic service-only operation for an
-- authenticated organization admin to add an existing account by exact email.
--
-- Rollback: disable signup/domain-membership intake and the worker
-- add-existing-member route first, then restore the 0439 auto-association body
-- and DROP FUNCTION public.add_existing_org_member(uuid,uuid,text,text).
-- Never serve the restored 0439 body while intake is enabled: it permits an
-- unverified matching domain to claim a confirmed signup.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.auto_associate_profile_to_org_by_email_domain(
  p_user_id uuid,
  p_email text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_domain text;
  v_org_id uuid;
  v_org_name text;
  v_match_count integer;
  v_profile_exists boolean;
  v_membership_count integer;
BEGIN
  IF p_user_id IS NULL OR p_email IS NULL OR position('@' in p_email) = 0 THEN
    RETURN NULL;
  END IF;

  IF private.requires_oauth_email_confirmation(p_user_id) THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = p_user_id
      AND raw_app_meta_data->>'admin_provisioned' = 'true'
  ) THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = p_user_id
      AND email_confirmed_at IS NOT NULL
  ) THEN
    RETURN NULL;
  END IF;

  v_domain := lower(trim(trailing '.' FROM split_part(p_email, '@', 2)));
  IF v_domain IS NULL OR v_domain = '' THEN
    RETURN NULL;
  END IF;

  -- Count and choose from one statement snapshot. A verified-domain row that
  -- commits between two READ COMMITTED statements must never turn an earlier
  -- count of one into an arbitrary tenant choice.
  SELECT count(*),
         (array_agg(id ORDER BY id))[1],
         (array_agg(display_name ORDER BY id))[1]
  INTO v_match_count, v_org_id, v_org_name
  FROM organizations
  WHERE lower(trim(trailing '.' FROM domain)) = v_domain
    AND domain_verified IS TRUE;

  -- More than one claimant is an organization-data conflict, not a reason to
  -- choose a tenant by creation time. Fail closed without membership writes.
  IF v_match_count <> 1 THEN
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
    SET org_id = COALESCE(org_id, v_org_id),
        role = COALESCE(role, 'ORG_MEMBER'::user_role),
        role_set_at = CASE WHEN role IS NULL THEN now() ELSE role_set_at END
    WHERE id = p_user_id
      AND (org_id IS NULL OR role IS NULL);

    IF v_membership_count > 0 THEN
      INSERT INTO audit_events (
        event_type, event_category, actor_id, target_type, target_id, org_id, details
      ) VALUES (
        'profile.org_auto_associated', 'PROFILE', p_user_id, 'profile', p_user_id,
        v_org_id, format('Auto-associated user to %s by verified email domain %s', v_org_name, v_domain)
      );
    END IF;
  END IF;

  RETURN v_org_id;
END;
$$;

REVOKE ALL ON FUNCTION public.auto_associate_profile_to_org_by_email_domain(uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_associate_profile_to_org_by_email_domain(uuid,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.add_existing_org_member(
  p_actor_id uuid,
  p_org_id uuid,
  p_email text,
  p_role text
) RETURNS TABLE (
  user_id uuid,
  email text,
  full_name text,
  idempotent boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target profiles%ROWTYPE;
  v_member_role org_member_role;
  v_existing_role org_member_role;
  v_inserted boolean := false;
  v_target_count integer;
BEGIN
  IF public.get_caller_role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_actor_id IS NULL OR p_org_id IS NULL OR p_email IS NULL OR btrim(p_email) = '' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  IF p_role = 'INDIVIDUAL' THEN
    v_member_role := 'member';
  ELSIF p_role = 'ORG_ADMIN' THEN
    v_member_role := 'admin';
  ELSE
    RAISE EXCEPTION 'invalid_role' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM organizations o
    WHERE o.id = p_org_id
      AND o.suspended IS FALSE
      AND coalesce(o.payment_state, 'ok') <> 'suspended'
  ) THEN
    RAISE EXCEPTION 'organization_unavailable' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = p_actor_id
      AND p.deleted_at IS NULL
      AND p.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = p_actor_id
      AND p.deleted_at IS NULL
      AND p.is_platform_admin IS TRUE
  ) AND NOT EXISTS (
    SELECT 1 FROM org_members om
    WHERE om.user_id = p_actor_id
      AND om.org_id = p_org_id
      AND om.role IN ('owner', 'admin')
  ) AND NOT EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = p_actor_id
      AND p.deleted_at IS NULL
      AND p.org_id = p_org_id
      AND p.role = 'ORG_ADMIN'
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_target_count
  FROM profiles p
  WHERE lower(p.email) = lower(btrim(p_email))
    AND p.deleted_at IS NULL
    AND p.status = 'ACTIVE';

  IF v_target_count = 0 THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_target_count <> 1 THEN
    RAISE EXCEPTION 'ambiguous_user' USING ERRCODE = 'P0003';
  END IF;

  SELECT p.* INTO STRICT v_target
  FROM profiles p
  WHERE lower(p.email) = lower(btrim(p_email))
    AND p.deleted_at IS NULL
    AND p.status = 'ACTIVE';

  INSERT INTO org_members (user_id, org_id, role, invited_by)
  VALUES (v_target.id, p_org_id, v_member_role, p_actor_id)
  ON CONFLICT ON CONSTRAINT org_members_unique_membership DO NOTHING
  RETURNING true INTO v_inserted;

  v_inserted := coalesce(v_inserted, false);

  IF NOT v_inserted THEN
    SELECT om.role INTO v_existing_role
    FROM org_members om
    WHERE om.user_id = v_target.id
      AND om.org_id = p_org_id;
    IF v_existing_role IS DISTINCT FROM v_member_role THEN
      RAISE EXCEPTION 'membership_role_conflict' USING ERRCODE = 'P0003';
    END IF;
  END IF;

  IF v_inserted THEN
    UPDATE profiles
    SET org_id = p_org_id,
        -- profiles.role is the immutable legacy primary-role projection. The
        -- requested per-organization authority lives in org_members.role, so
        -- never rewrite an existing profile role while backfilling org_id.
        role = COALESCE(role, p_role::user_role),
        role_set_at = CASE WHEN role IS NULL THEN now() ELSE role_set_at END
    WHERE id = v_target.id
      AND org_id IS NULL;

    INSERT INTO audit_events (
      event_type, event_category, actor_id, target_type, target_id, org_id, details
    ) VALUES (
      'MEMBER_ADDED', 'ORGANIZATION', p_actor_id, 'user', v_target.id::text,
      p_org_id, json_build_object('role', v_member_role, 'via', 'org_admin_exact_email')::text
    );
  END IF;

  RETURN QUERY SELECT v_target.id, v_target.email, v_target.full_name, NOT v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.add_existing_org_member(uuid,uuid,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_existing_org_member(uuid,uuid,text,text)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
