-- 0466: Fail closed when referral RPC caller claims omit `role`.
--
-- `get_caller_role()` correctly returns NULL when PostgREST/JWT claims are absent.
-- In PL/pgSQL, `IF NOT NULL AND ...` evaluates to NULL and does not enter the
-- branch. Migration 0456 therefore let a direct call with empty claims skip both
-- SECURITY DEFINER tenant guards. Normal PostgREST calls supply a role and the
-- database roles are NOLOGIN, so this is defense in depth; no exploit was observed.
--
-- Both sibling RPCs use the same predicate and are replaced together. COALESCE
-- preserves service_role and authenticated behavior while treating missing role
-- context as non-service.
--
-- ROLLBACK: Do not restore 0456's nullable predicate. If this feature must be
-- rolled back, revoke EXECUTE and drop these RPCs with the referral feature per
-- 0456's rollback guidance.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.record_org_referral(
  p_org_id uuid,
  p_code text,
  p_source text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_is_service boolean := coalesce(public.get_caller_role() = 'service_role', false);
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_actor uuid := auth.uid();
  v_referrer_org_id uuid;
  v_referral_code_id uuid;
  v_referrer_public_id text;
  v_rows integer := 0;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'p_org_id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('signup', 'admin_provisioning', 'api') THEN
    RAISE EXCEPTION 'p_source must be one of signup, admin_provisioning, api'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- TENANT AUTHORITY. See header note 1. `NOT EXISTS`, not `NOT IN`: a NULL in
  -- the set would make `NOT IN` evaluate to NULL and the guard fail OPEN.
  -- Membership is the bar; minting a code is the admin-gated action.
  IF NOT v_is_service
     AND NOT EXISTS (SELECT 1 FROM public.get_user_org_ids() g WHERE g = p_org_id) THEN
    RAISE EXCEPTION 'Not authorized to record a referral for this organization'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- CALLER-ASSERTED SOURCE. A non-service caller can only ever be recording
  -- their OWN signup; service_role is what actually runs admin provisioning
  -- or the public API. Without this guard an ordinary authenticated user could
  -- call this RPC asserting p_source = 'admin_provisioning' or 'api',
  -- misrepresenting how the referral was recorded to anyone reading `source`
  -- off the audit trail or partner analytics. This is an authority failure,
  -- not a verdict, so it RAISES like the tenant-membership check above it
  -- rather than returning a jsonb reason.
  IF NOT v_is_service AND p_source <> 'signup' THEN
    RAISE EXCEPTION 'Only service_role may record a referral with p_source other than signup'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- No code presented. The overwhelmingly common case (most signups are not
  -- referred), so it is deliberately NOT audited — an audit row per unreferred
  -- signup is noise that would bury the rows that matter.
  IF v_code = '' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_code');
  END IF;

  SELECT rc.id, rc.org_id INTO v_referral_code_id, v_referrer_org_id
  FROM public.referral_codes rc
  WHERE rc.code = v_code AND rc.active
  LIMIT 1;

  IF v_referrer_org_id IS NULL THEN
    -- Audited. A user who typed a code and got nothing is a support question,
    -- and a burst of these is either a partner circulating a retired code or
    -- someone probing the code space. The code itself is recorded because it is
    -- a public, shareable string, not a secret — but bounded to 32 characters:
    -- `audit_events_details_length` CHECKs `char_length(details) <= 10000`, and
    -- an unbounded `p_code` would make this INSERT raise out of a function whose
    -- contract is a total verdict that never raises. A valid code is 8.
    INSERT INTO public.audit_events (
      event_type, event_category, actor_id, target_type, target_id, org_id, details
    ) VALUES (
      'organization.referral_code_invalid', 'ORG', v_actor, 'organization',
      p_org_id::text, p_org_id,
      json_build_object('code', left(v_code, 32), 'source', p_source)::text
    );
    RETURN jsonb_build_object('applied', false, 'reason', 'unknown_code');
  END IF;

  IF v_referrer_org_id = p_org_id THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'self_referral');
  END IF;

  INSERT INTO public.organization_referrals (
    referred_org_id, referrer_org_id, referral_code_id, referral_code_used, source
  ) VALUES (
    p_org_id, v_referrer_org_id, v_referral_code_id, v_code, p_source
  )
  ON CONFLICT (referred_org_id) DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    -- The organization already has a referrer. First attribution wins; a later
    -- code never overwrites one, so a partner cannot capture someone else's
    -- referral by getting a second code in front of the same organization.
    RETURN jsonb_build_object('applied', false, 'reason', 'already_attributed');
  END IF;

  SELECT o.public_id INTO v_referrer_public_id
  FROM public.organizations o
  WHERE o.id = v_referrer_org_id;

  -- org_id is the REFERRER, not the referred organization: the partner's own
  -- audit export is the only place this event may appear.
  --
  -- actor_id is NULL, and that is the point. `audit_events_select` is
  -- `USING (actor_id = (SELECT auth.uid()))` and `authenticated` holds SELECT on
  -- the table, so filing this row against the signing-up user — a member of the
  -- REFERRED organization — would let them read back the referrer's raw org uuid
  -- in `org_id` and `target_id`, defeating through the audit table exactly the
  -- disclosure boundary `organization_referrals` enforces. The partner reads
  -- this row through the service_role audit export, which filters on `org_id`
  -- and does not need an actor. See header note 2.
  INSERT INTO public.audit_events (
    event_type, event_category, actor_id, target_type, target_id, org_id, details
  ) VALUES (
    'organization.referred', 'ORG', NULL, 'organization',
    v_referrer_org_id::text, v_referrer_org_id,
    json_build_object('source', p_source, 'code', v_code)::text
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'applied', true,
    'reason', 'recorded',
    'referrer_public_id', v_referrer_public_id
  ));
END;
$function$;

-- Restated rather than assumed: CREATE OR REPLACE preserves the existing ACL,
-- but these lines make the grant set explicit at the head of the ledger and are
-- idempotent on a database where `0455` already ran.
REVOKE ALL ON FUNCTION public.record_org_referral(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_org_referral(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_org_referral(uuid, text, text) TO service_role;

COMMENT ON FUNCTION public.record_org_referral(uuid, text, text) IS
  'Records at most one referrer per organization. Requires service_role OR membership of p_org_id — SECURITY DEFINER means this body is the only authority check that runs. Returns a TOTAL jsonb verdict — no_code / unknown_code / self_referral / already_attributed / recorded — and never raises for a bad code, because callers run after the organization already exists. organization.referred is audited against the REFERRER org with a NULL actor: an actor-scoped read by the referred user would otherwise disclose the referrer.';

CREATE OR REPLACE FUNCTION public.get_org_referrals(p_org_id uuid)
RETURNS TABLE (
  organization_public_id text,
  display_name text,
  referred_at timestamptz,
  verification_status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_is_service boolean := coalesce(public.get_caller_role() = 'service_role', false);
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'p_org_id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- SECURITY DEFINER bypasses the SELECT policy, so the tenant check has to be
  -- made explicitly here. Membership (not admin) is the bar for reading your own
  -- organization's referrals; minting is the admin-gated action.
  --
  -- `NOT EXISTS`, not `NOT IN`: see header note 4.
  IF NOT v_is_service
     AND NOT public.is_current_user_platform_admin()
     AND NOT EXISTS (SELECT 1 FROM public.get_user_org_ids() g WHERE g = p_org_id) THEN
    RAISE EXCEPTION 'Not authorized to read referrals for this organization'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT o.public_id, o.display_name, r.referred_at, o.verification_status
  FROM public.organization_referrals r
  JOIN public.organizations o ON o.id = r.referred_org_id
  WHERE r.referrer_org_id = p_org_id
  ORDER BY r.referred_at DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_org_referrals(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_org_referrals(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_org_referrals(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
