-- 0455_scrum5024_partner_referral_attribution.sql
-- SCRUM-5024: partner referral codes and organization attribution.
--
-- Partner referrals are tracked by hand in a spreadsheet today. This adds the
-- two durable tables plus the four RPCs the signup, admin-provisioning and API
-- surfaces call, so an attribution is recorded by the same transaction that
-- observes it rather than reconstructed later.
--
-- NO DDL ON `organizations`. Both new tables take foreign keys INTO it, which
-- requires ShareRowExclusiveLock on `organizations` (a hot table, CLAUDE.md
-- §1.2) — hence the file-level `SET LOCAL lock_timeout = '5s'` as the first
-- statement inside BEGIN. Nothing here alters, adds a column to, or creates a
-- trigger on `organizations` itself.
--
-- DISCLOSURE BOUNDARY (deliberate; founder acknowledgement requested in the PR):
--   * The REFERRER (the partner) can see which organizations they referred, via
--     `get_org_referrals` — public id, display name, referral timestamp and
--     verification status only. No tier, no credit balance, no domain, no EIN,
--     no member list, no anchor counts.
--   * The REFERRED organization can see NOTHING. There is no SELECT policy that
--     matches on `referred_org_id`, and `COMMENT ON TABLE` records that this is
--     intentional rather than an oversight.
--   * Platform admins can read both tables.
--
-- NO COMMERCIAL MEANING. These rows record who introduced whom. They do not
-- imply, compute or authorise a commission, discount, payout or credit. No
-- Stripe surface reads them.
--
-- ROLLBACK: (drops attribution data — export `organization_referrals` first if
-- any row exists)
-- BEGIN;
-- SET LOCAL lock_timeout = '5s';
-- DROP FUNCTION IF EXISTS public.get_org_referrals(uuid);
-- DROP FUNCTION IF EXISTS public.record_org_referral(uuid, text, text);
-- DROP FUNCTION IF EXISTS public.ensure_org_referral_code(uuid);
-- DROP FUNCTION IF EXISTS public.generate_referral_code();
-- DROP TABLE IF EXISTS public.organization_referrals;
-- DROP TABLE IF EXISTS public.referral_codes;
-- NOTIFY pgrst, 'reload schema';
-- COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ─────────────────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────────────────

-- The code alphabet is Crockford-style: the full uppercase Latin set and the
-- digits, MINUS I, L, O, 0 and 1. A referral code is read off a slide, typed
-- from a phone screen and dictated over a call, so the pairs that are
-- indistinguishable in most typefaces are removed rather than "handled" by a
-- normaliser nobody will keep in sync. 31 symbols, 8 positions.
--
-- The CHECK below is the single authority on the format. `record_org_referral`
-- upper-cases and trims before matching, `referralCapture.ts` and the
-- admin-provisioning Zod schema reject anything else client-side, and the test
-- mocks enforce this same class — but the constraint is what actually holds.
CREATE TABLE IF NOT EXISTS public.referral_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT referral_codes_code_unique UNIQUE (code),
  CONSTRAINT referral_codes_code_format
    CHECK (code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$'),
  -- An inactive row must say when it was retired, and an active row must not
  -- claim to have been. Without this, `active = false, revoked_at = NULL` is a
  -- code that silently stopped working with no record of when.
  CONSTRAINT referral_codes_revoked_consistent
    CHECK ((active AND revoked_at IS NULL) OR (NOT active AND revoked_at IS NOT NULL))
);

COMMENT ON TABLE public.referral_codes IS
  'Partner referral codes (SCRUM-5024). One ACTIVE code per organization, enforced by referral_codes_one_active_per_org. Rows are written only by ensure_org_referral_code() or service_role — there is no INSERT/UPDATE/DELETE policy for authenticated. Holding a code carries no commercial entitlement.';

COMMENT ON COLUMN public.referral_codes.code IS
  'Uppercase, 8 characters from ABCDEFGHJKMNPQRSTUVWXYZ23456789 (I, L, O, 0, 1 excluded as visually ambiguous). Enforced by referral_codes_code_format.';

-- Partial unique index rather than a constraint: the uniqueness only holds over
-- the ACTIVE rows, so retiring a code and minting a replacement stays legal and
-- the history is kept.
CREATE UNIQUE INDEX IF NOT EXISTS referral_codes_one_active_per_org
  ON public.referral_codes (org_id)
  WHERE active;

-- `referred_org_id` is the PRIMARY KEY, not just a column: an organization is
-- referred by at most one partner, once, forever. That makes the replay guard
-- in `record_org_referral` an `ON CONFLICT DO NOTHING` against a real
-- constraint instead of a read-then-write race.
CREATE TABLE IF NOT EXISTS public.organization_referrals (
  referred_org_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  referrer_org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE: retiring or deleting the code must never erase the
  -- attribution it produced. `referral_code_used` keeps the literal string that
  -- was presented, so the row stays readable after the code row is gone.
  referral_code_id uuid REFERENCES public.referral_codes(id) ON DELETE SET NULL,
  referral_code_used text NOT NULL,
  referred_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  CONSTRAINT organization_referrals_source_valid
    CHECK (source IN ('signup', 'admin_provisioning', 'api')),
  CONSTRAINT organization_referrals_no_self
    CHECK (referred_org_id <> referrer_org_id)
);

COMMENT ON TABLE public.organization_referrals IS
  'Which organization introduced which (SCRUM-5024). DISCLOSURE BOUNDARY, DELIBERATE: only the REFERRER can read its rows. The referred organization has no SELECT policy here and is not told it was attributed — that asymmetry is the design, not a missing policy. Rows are written only by record_org_referral() or service_role. Carries no commercial entitlement: nothing computes a commission, discount or payout from this table.';

COMMENT ON COLUMN public.organization_referrals.source IS
  'Where the attribution was observed: signup (self-serve onboarding), admin_provisioning (platform-admin created the org), api. Enforced by organization_referrals_source_valid.';

CREATE INDEX IF NOT EXISTS organization_referrals_referrer_referred_at_idx
  ON public.organization_referrals (referrer_org_id, referred_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_codes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.organization_referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_referrals FORCE ROW LEVEL SECURITY;

-- `get_user_org_ids()` and `is_current_user_platform_admin()` are the existing
-- STABLE SECURITY DEFINER helpers (baseline:4257 / baseline:4437). Using them
-- rather than a bare `auth.uid()` join keeps the predicate an InitPlan instead
-- of a per-row evaluation (SCRUM-1278) and keeps one definition of membership.
CREATE POLICY referral_codes_select_member ON public.referral_codes
  FOR SELECT TO authenticated
  USING (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY referral_codes_select_platform_admin ON public.referral_codes
  FOR SELECT TO authenticated
  USING (public.is_current_user_platform_admin());

-- REFERRER ONLY. There is deliberately no policy matching `referred_org_id`.
CREATE POLICY organization_referrals_select_referrer ON public.organization_referrals
  FOR SELECT TO authenticated
  USING (referrer_org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY organization_referrals_select_platform_admin ON public.organization_referrals
  FOR SELECT TO authenticated
  USING (public.is_current_user_platform_admin());

-- No INSERT / UPDATE / DELETE policy on either table, for any role. Writes go
-- through the SECURITY DEFINER RPCs below or through service_role. FORCE ROW
-- LEVEL SECURITY means even the table owner is subject to the policies, so the
-- absence of a write policy is a real prohibition and not a formality.

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants
-- ─────────────────────────────────────────────────────────────────────────────
--
-- REVOKE FROM PUBLIC alone is NOT sufficient on Supabase: `ALTER DEFAULT
-- PRIVILEGES` in this project grants `anon` and `authenticated` directly at
-- CREATE TABLE time, and a direct grant survives a revoke from PUBLIC. Both
-- roles are therefore named explicitly.
REVOKE ALL ON public.referral_codes FROM PUBLIC;
REVOKE ALL ON public.referral_codes FROM anon;
REVOKE ALL ON public.referral_codes FROM authenticated;
REVOKE ALL ON public.organization_referrals FROM PUBLIC;
REVOKE ALL ON public.organization_referrals FROM anon;
REVOKE ALL ON public.organization_referrals FROM authenticated;

GRANT SELECT ON public.referral_codes TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.referral_codes TO service_role;
GRANT SELECT ON public.organization_referrals TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.organization_referrals TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Functions
-- ─────────────────────────────────────────────────────────────────────────────

-- Code generator. NOT callable by anon or authenticated: it is an internal
-- helper of `ensure_org_referral_code`, and exposing a code oracle to any
-- signed-in user is free reconnaissance on the code space.
--
-- Randomness comes from `gen_random_uuid()` (CSPRNG-backed in PostgreSQL 13+),
-- not `random()`, whose per-session PRNG state is seedable and predictable.
-- Stated honestly: reducing 8 bits to one of 31 symbols by modulo leaves a
-- small bias toward the first 8 symbols (256 = 8*31 + 8), so the effective
-- entropy is slightly under the ideal 8*log2(31) ~= 39.6 bits. That is
-- acceptable here — a guessed code misattributes a signup, it does not grant
-- access to anything — and the one-active-per-org unique index bounds how many
-- live codes exist at all.
CREATE OR REPLACE FUNCTION public.generate_referral_code()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_bytes bytea := decode(md5(gen_random_uuid()::text), 'hex');
  v_code text := '';
  v_i integer;
BEGIN
  FOR v_i IN 0..7 LOOP
    v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, v_i) % 31) + 1, 1);
  END LOOP;
  RETURN v_code;
END;
$function$;

REVOKE ALL ON FUNCTION public.generate_referral_code() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_referral_code() FROM anon;
REVOKE ALL ON FUNCTION public.generate_referral_code() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.generate_referral_code() TO service_role;

COMMENT ON FUNCTION public.generate_referral_code() IS
  'Internal helper for ensure_org_referral_code(). service_role only — a code oracle callable by any signed-in user is reconnaissance on the code space.';

-- Idempotent mint. Returns the organization existing ACTIVE code when there is
-- one, so a double-click, a retried request and a second admin all converge on
-- the same string rather than racing to rotate it.
--
-- Authority: service_role (the worker) OR an admin/owner of the target org.
-- A plain member cannot mint.
CREATE OR REPLACE FUNCTION public.ensure_org_referral_code(p_org_id uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_is_service boolean := (public.get_caller_role() = 'service_role');
  v_actor uuid := auth.uid();
  v_code text;
  v_candidate text;
  v_attempt integer;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'p_org_id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF NOT v_is_service AND NOT public.is_org_admin_of(p_org_id) THEN
    RAISE EXCEPTION 'Not authorized to mint a referral code for this organization'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT code INTO v_code
  FROM public.referral_codes
  WHERE org_id = p_org_id AND active
  LIMIT 1;

  IF v_code IS NOT NULL THEN
    RETURN v_code;
  END IF;

  -- Bounded retry on the global UNIQUE(code). Eight attempts against a space of
  -- ~31^8 with at most one live code per organization: exhausting this means
  -- the generator is broken, and raising is the correct outcome. A silent NULL
  -- return here would surface in the UI as "no code yet" forever.
  FOR v_attempt IN 1..8 LOOP
    v_candidate := public.generate_referral_code();
    BEGIN
      INSERT INTO public.referral_codes (org_id, code, created_by)
      VALUES (p_org_id, v_candidate, v_actor)
      RETURNING code INTO v_code;
      EXIT;
    EXCEPTION
      WHEN unique_violation THEN
        -- Two distinct collisions are possible and they need opposite answers.
        -- A collision on referral_codes_one_active_per_org means a concurrent
        -- session already minted this organization code: adopt it, that IS the
        -- idempotent outcome. A collision on referral_codes_code_unique is a
        -- code-space collision: try again.
        SELECT code INTO v_code
        FROM public.referral_codes
        WHERE org_id = p_org_id AND active
        LIMIT 1;
        IF v_code IS NOT NULL THEN
          RETURN v_code;
        END IF;
        v_code := NULL;
    END;
  END LOOP;

  IF v_code IS NULL THEN
    RAISE EXCEPTION 'Could not allocate a unique referral code after 8 attempts'
      USING ERRCODE = 'internal_error';
  END IF;

  INSERT INTO public.audit_events (
    event_type, event_category, actor_id, target_type, target_id, org_id, details
  ) VALUES (
    'organization.referral_code_issued', 'ORG', v_actor, 'organization',
    p_org_id::text, p_org_id,
    json_build_object('source', CASE WHEN v_is_service THEN 'service_role' ELSE 'org_admin' END)::text
  );

  RETURN v_code;
END;
$function$;

REVOKE ALL ON FUNCTION public.ensure_org_referral_code(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_org_referral_code(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.ensure_org_referral_code(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_org_referral_code(uuid) TO service_role;

COMMENT ON FUNCTION public.ensure_org_referral_code(uuid) IS
  'Idempotent: returns the organization existing ACTIVE referral code, or mints one. Authority is service_role OR is_org_admin_of(p_org_id). Emits organization.referral_code_issued only when a code is actually created.';

-- Records an attribution. Returns a jsonb verdict rather than raising, because
-- every caller runs AFTER the organization already exists and must not undo a
-- successful signup because a referral code was mistyped.
--
-- The verdict is TOTAL — exactly one of these reasons is always returned, and
-- callers count them. There is no path that returns nothing:
--   {applied:false, reason:'no_code'}            — blank/absent input; not an event
--   {applied:false, reason:'unknown_code'}       — no such ACTIVE code (audited)
--   {applied:false, reason:'self_referral'}      — the org presented its own code
--   {applied:false, reason:'already_attributed'} — this org already has a referrer
--   {applied:true,  reason:'recorded', referrer_public_id: ...}
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
    -- someone probing the code space. The code itself is recorded because it
    -- is a public, shareable string, not a secret.
    INSERT INTO public.audit_events (
      event_type, event_category, actor_id, target_type, target_id, org_id, details
    ) VALUES (
      'organization.referral_code_invalid', 'ORG', v_actor, 'organization',
      p_org_id::text, p_org_id,
      json_build_object('code', v_code, 'source', p_source)::text
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
    -- code never overwrites one, so a partner cannot capture someone else
    -- referral by getting a second code in front of the same organization.
    RETURN jsonb_build_object('applied', false, 'reason', 'already_attributed');
  END IF;

  SELECT o.public_id INTO v_referrer_public_id
  FROM public.organizations o
  WHERE o.id = v_referrer_org_id;

  -- org_id is the REFERRER, not the referred organization. The partner own
  -- audit export is where this event belongs and is the only place it may
  -- appear: writing it against the referred org would disclose to them that
  -- they were attributed, which is exactly what the disclosure boundary on
  -- organization_referrals refuses.
  INSERT INTO public.audit_events (
    event_type, event_category, actor_id, target_type, target_id, org_id, details
  ) VALUES (
    'organization.referred', 'ORG', v_actor, 'organization',
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

REVOKE ALL ON FUNCTION public.record_org_referral(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_org_referral(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_org_referral(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_org_referral(uuid, text, text) TO service_role;

COMMENT ON FUNCTION public.record_org_referral(uuid, text, text) IS
  'Records at most one referrer per organization. Returns a TOTAL jsonb verdict — no_code / unknown_code / self_referral / already_attributed / recorded — and never raises for a bad code, because callers run after the organization already exists. organization.referred is audited against the REFERRER org, never the referred one.';

-- The referrer read path. Restricted to the four fields the partner needs to
-- recognise an organization they introduced. Everything else about the referred
-- organization — tier, credit balance, domain, EIN, members, anchor counts — is
-- outside this boundary and must not be added here without a product decision
-- recorded in the Confluence page.
--
-- `organization_public_id` may be NULL for an organization that predates the
-- public-id backfill; the API layer and the panel omit the field rather than
-- publishing a null.
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
  v_is_service boolean := (public.get_caller_role() = 'service_role');
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'p_org_id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- SECURITY DEFINER bypasses the SELECT policy above, so the tenant check has
  -- to be made explicitly here. Membership (not admin) is the bar for reading
  -- your own organization referrals; minting is the admin-gated action.
  IF NOT v_is_service
     AND NOT public.is_current_user_platform_admin()
     AND p_org_id NOT IN (SELECT public.get_user_org_ids()) THEN
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

REVOKE ALL ON FUNCTION public.get_org_referrals(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_org_referrals(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_org_referrals(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_org_referrals(uuid) TO service_role;

COMMENT ON FUNCTION public.get_org_referrals(uuid) IS
  'Referrer-side read of organizations this org introduced. Projects public id, display name, referral timestamp and verification status ONLY — the disclosure boundary recorded on organization_referrals. Callable by a member of p_org_id, a platform admin, or service_role.';

NOTIFY pgrst, 'reload schema';

COMMIT;
