-- SCRUM-3873: organization creation, initial grant and receipt are one commit.
-- Reproduced on the original isolated worker: a retry reset balance 18 to 7
-- while the ledger rose to 25; four concurrent grants of 5 booked four grants.
-- 0422 is already applied and remains immutable. This forward migration makes
-- its organization key cover the complete operation, including its payload.
--
-- ROLLBACK (deploy the prior worker only while provisioning is disabled):
-- BEGIN;
-- SET LOCAL lock_timeout = '5s';
-- DROP FUNCTION IF EXISTS public.admin_provision_organization(uuid, uuid, text, text, integer, integer, boolean, boolean);
-- NOTIFY pgrst, 'reload schema';
-- COMMIT;
-- Preserve admin_org_provisioning_requests and its rows as replay/audit evidence.
-- Removing the RPC intentionally fails provisioning closed; the old worker's
-- multi-transaction credit reset is not a safe writable fallback.

-- Depends on0436_scrum4035_oauth_email_confirmation.sql: preserve its pending
-- mailbox guard verbatim.0439 must not be applied before0436.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
  IF to_regprocedure('private.requires_oauth_email_confirmation(uuid)') IS NULL THEN
    RAISE EXCEPTION '0439 requires migration0436 before deployment';
  END IF;
END $$;

CREATE TABLE public.admin_org_provisioning_requests (
  idempotency_key uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES public.profiles(id),
  org_id uuid NOT NULL UNIQUE REFERENCES public.organizations(id),
  request jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.admin_org_provisioning_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_org_provisioning_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_org_provisioning_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.admin_org_provisioning_requests TO service_role;
COMMENT ON TABLE public.admin_org_provisioning_requests IS
  'Deny-all by design (R3-2). See SCRUM-4455. Only the owner-executed atomic provisioning function writes receipts; service_role has read-only inspection access.';

CREATE OR REPLACE FUNCTION public.admin_provision_organization(
  p_actor uuid,
  p_idempotency_key uuid,
  p_display_name text,
  p_legal_name text,
  p_anchor_quota integer,
  p_credits integer,
  p_is_test boolean,
  p_allow_duplicate_name boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET lock_timeout = '5s'
AS $$
DECLARE
  v_request jsonb;
  v_prior public.admin_org_provisioning_requests%ROWTYPE;
  v_org public.organizations%ROWTYPE;
  v_credits public.org_credits%ROWTYPE;
  v_existing_id uuid;
  v_grant jsonb;
BEGIN
  -- EXECUTE is service_role-only; also bind the asserted actor to current
  -- platform authority so a removed admin cannot complete a stale request.
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_actor AND is_platform_admin = true) THEN
    RAISE EXCEPTION 'Platform admin required' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL OR NULLIF(btrim(p_display_name), '') IS NULL
     OR char_length(p_display_name) > 200 OR NULLIF(btrim(p_legal_name), '') IS NULL
     OR char_length(p_legal_name) > 200 OR p_credits IS NULL OR p_credits < 0
     OR p_anchor_quota < 0 OR p_is_test IS NULL OR p_allow_duplicate_name IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_input');
  END IF;
  v_request := jsonb_build_object('display_name', p_display_name, 'legal_name', p_legal_name,
    'anchor_quota', p_anchor_quota, 'credits', p_credits, 'is_test', p_is_test,
    'allow_duplicate_name', p_allow_duplicate_name);

  -- Serialize a complete submission, not only its INSERT. The lock is released
  -- on rollback too: a retry may safely finish a failed initialization.
  PERFORM pg_advisory_xact_lock(hashtext('admin_org_provisioning_key'), hashtext(p_idempotency_key::text));
  SELECT * INTO v_prior FROM admin_org_provisioning_requests WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_prior.actor_id <> p_actor OR v_prior.request <> v_request THEN
      RETURN jsonb_build_object('success', false, 'error', 'idempotency_key_conflict');
    END IF;
    SELECT * INTO STRICT v_org FROM organizations WHERE id = v_prior.org_id;
    SELECT * INTO STRICT v_credits FROM org_credits WHERE org_id = v_prior.org_id;
  ELSE
    -- A pre-0439 partial operation has no atomic receipt. Never infer that its
    -- credits completed, reset its balance, or silently replay a second grant.
    IF EXISTS (SELECT 1 FROM organizations WHERE creation_idempotency_key = p_idempotency_key) THEN
      RETURN jsonb_build_object('success', false, 'error', 'idempotency_key_conflict');
    END IF;
    IF NOT p_allow_duplicate_name THEN
      PERFORM pg_advisory_xact_lock(hashtext('admin_org_provisioning_name'), hashtext(p_display_name));
      SELECT id INTO v_existing_id FROM organizations WHERE display_name = p_display_name LIMIT 1;
      IF FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'org_exists', 'existing_org_id', v_existing_id);
      END IF;
    END IF;
    INSERT INTO organizations(display_name, legal_name, verification_status, tier, creation_idempotency_key)
    VALUES (p_display_name, p_legal_name, 'UNVERIFIED', 'FREE', p_idempotency_key)
    RETURNING * INTO v_org;

    -- Preserve the seed trigger's balance and all money counters. Only the
    -- newly created organization's requested quota/test setting are changed.
    INSERT INTO org_credits(org_id, is_test, anchor_quota)
    VALUES (v_org.id, p_is_test, p_anchor_quota)
    ON CONFLICT (org_id) DO UPDATE SET is_test = EXCLUDED.is_test, anchor_quota = EXCLUDED.anchor_quota;
    IF p_credits > 0 THEN
      v_grant := admin_adjust_org_credit(v_org.id, p_credits,
        'Starting credits at organization provisioning', p_idempotency_key, p_actor);
      IF v_grant->>'success' IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'Initial credit grant failed' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    INSERT INTO admin_org_provisioning_requests(idempotency_key, actor_id, org_id, request)
    VALUES (p_idempotency_key, p_actor, v_org.id, v_request);
    INSERT INTO audit_events(event_type, event_category, actor_id, target_type, target_id, org_id, details)
    VALUES ('ORGANIZATION_PROVISIONED', 'ORGANIZATION', p_actor, 'organization', v_org.id::text,
      v_org.id, (v_request || jsonb_build_object('idempotency_key', p_idempotency_key))::text);
    SELECT * INTO STRICT v_credits FROM org_credits WHERE org_id = v_org.id;
  END IF;
  RETURN jsonb_build_object('success', true, 'organization', jsonb_build_object(
    'org_id', v_org.id, 'public_id', v_org.public_id, 'org_prefix', v_org.org_prefix,
    'display_name', v_org.display_name, 'anchor_quota', v_credits.anchor_quota,
    'credits_balance', v_credits.balance, 'is_test', v_credits.is_test));
END;
$$;

REVOKE ALL ON FUNCTION public.admin_provision_organization(uuid, uuid, text, text, integer, integer, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_provision_organization(uuid, uuid, text, text, integer, integer, boolean, boolean) TO service_role;
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

  -- Only Auth's service-admin API can set raw_app_meta_data. A browser's
  -- user_metadata cannot opt out of mailbox proof or grant tenant authority.
  -- Explicit account placement (including INDIVIDUAL/no organization) is
  -- authoritative; future ordinary invitations remain independently usable.
  IF EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id
      AND raw_app_meta_data->>'admin_provisioned' = 'true') THEN
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
