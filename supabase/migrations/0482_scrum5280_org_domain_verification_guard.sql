-- =============================================================================
-- 0482 — Organization domain-verification write authority (SCRUM-5280),
--        add_existing_org_member stale-role fallback removal,
--        and the 3-argument queue-resolution overload ACL (SCRUM-5282).
--
-- Compensating migration. 0429, 0470, 0477 and 0399 are immutable; nothing in
-- them is edited. Every change here is a CREATE OR REPLACE or a REVOKE.
--
-- -----------------------------------------------------------------------------
-- A. SCRUM-5280 — an org admin could verify a domain they do not own
-- -----------------------------------------------------------------------------
-- `organizations_update_admin` is `is_org_admin_of(id)` for UPDATE, with no
-- column list: an org admin may write EVERY column of their own row. The only
-- BEFORE UPDATE authority trigger, `protect_org_tenancy_fields()` (0429),
-- guards exactly three columns — `credit_enforcement_enabled` and the two
-- sub-org listing consents. None of the eight triggers on `organizations`
-- mentions `domain_verified`. Verified read-only against production.
--
-- Since 0470, `auto_associate_profile_to_org_by_email_domain()` joins every
-- confirmed signup to the single organization whose `domain_verified IS TRUE`
-- matches the signup's email domain. So:
--
--     UPDATE organizations SET domain='victim.com', domain_verified=true
--      WHERE id = <my own org>;
--
-- makes every later @victim.com signup a member of the attacker's tenant —
-- a cross-tenant account-capture reachable by any org admin over PostgREST.
--
-- THE TOKEN COLUMNS ARE PART OF THE SAME HOLE.
--   `POST /api/v1/orgs/confirm-domain` (services/worker/src/api/v1/
--   orgVerification.ts) reads `organizations.domain_verification_token`, splits
--   it on `:`, and compares the first field to the code the caller supplies.
--   That stored token is the only secret in the flow. An org admin who can
--   write `domain_verification_token` sets it to a value they chose and then
--   asks the worker to verify it — and the worker writes `domain_verified=true`
--   as service_role, through the front door. Guarding only the four columns in
--   the ticket would therefore have left a complete bypass, so
--   `domain_verification_token` and `domain_verification_token_expires_at` are
--   guarded here too. This is the one deliberate addition to the specified
--   column set, and it is load-bearing.
--
-- WHY service_role ONLY, NOT `service_role OR platform admin` (unlike 0429).
--   Every write that legitimately sets verification state is the worker's
--   service_role client: `submit-ein` (verification_status), `start-domain`
--   (token pair), `confirm-domain` and the platform-admin manual verify
--   (domain_verified / method / verified_at / verification_status). All four go
--   through `db` in `services/worker/src/api/v1/orgVerification.ts`, which is
--   `createClient(..., config.supabaseServiceKey)`. No browser code writes any
--   of these columns: `EditableOrgFields` in `src/hooks/useOrganization.ts` is
--   display_name / domain / description / website_url / logo_url /
--   founded_date / org_type / linkedin_url / twitter_url / industry_tag /
--   location, and a repository-wide grep for a client-side write of
--   `domain_verified*` / `verification_status` on `organizations` finds none.
--   A platform-admin exemption would therefore protect no caller while leaving
--   a second self-assert route open through PostgREST, so it is not granted.
--   0429's three columns keep their original `service_role OR platform admin`
--   predicate, verbatim and unchanged.
--
-- WHY EDITING THE DOMAIN DEMOTES RATHER THAN RAISES.
--   Org admins legitimately edit `domain` today — it is in `EditableOrgFields`
--   and the settings form PATCHes the whole object on every save. Blocking the
--   edit would be a product regression; silently keeping a verification that
--   was granted for a different domain would be the SCRUM-5280 hole with extra
--   steps. So a real domain change by a non-service_role caller drops
--   `domain_verified`, `domain_verification_method`, `domain_verified_at` and
--   any pending token. "Real" is `IS DISTINCT FROM` over
--   `lower(trim(trailing '.' from ...))`, the same normalization 0470 uses, so
--   a no-op re-save of the identical domain does NOT demote.
--
--   RESIDUAL, STATED PLAINLY: `verification_status` is NOT demoted on a domain
--   change. It is a combined EIN + domain judgement owned by the worker, and
--   downgrading it here would silently strip the verified badge from orgs that
--   merely rename their domain. It is guarded against direct writes above, and
--   auto-association keys on `domain_verified`, not on `verification_status`,
--   so the capture vector is closed either way. An organization can therefore
--   still read `verification_status = 'VERIFIED'` with `domain_verified =
--   false`; reconciling those rows is worker/ops work, not a trigger's.
--
-- TRIGGER SHAPE: `trg_protect_org_tenancy_fields` is
--   `BEFORE UPDATE ON public.organizations FOR EACH ROW` — NOT column-scoped
--   (verified from `pg_get_triggerdef`). It already fires on a domain-only
--   UPDATE, so the trigger is NOT dropped and recreated and this migration
--   takes no AccessExclusiveLock on `organizations`. `SET LOCAL lock_timeout`
--   is still set per CLAUDE.md §1.2 because the file touches the hot table's
--   trigger function.
--
-- -----------------------------------------------------------------------------
-- B. add_existing_org_member — stale profile-role fallback (0470)
-- -----------------------------------------------------------------------------
-- 0470 authorizes the actor three ways: platform admin, exact `org_members`
-- owner/admin of `p_org_id`, OR `profiles.org_id = p_org_id AND profiles.role
-- = 'ORG_ADMIN'`. The third is a stale-role fallback: `profiles.role` is the
-- immutable legacy primary-role projection (0470's own comment says so) and
-- outlives a membership demotion, so a removed admin keeps the authority to
-- add members. 0477 removed exactly this fallback from the queue RPC — "Profile
-- role/org fields are not an authorization fallback because they can outlive
-- membership demotion". Removed here for the same reason. Signature, argument
-- names, return shape and every other check are byte-identical to 0470, so the
-- deployed worker route keeps working.
--
-- -----------------------------------------------------------------------------
-- C. SCRUM-5282 — resolve_anchor_queue_by_public_id(text,text,text)
-- -----------------------------------------------------------------------------
-- The 3-argument overload (last defined in 0399) is SECURITY DEFINER, holds
-- EXECUTE for `anon` and `authenticated`, and authorizes on
-- `caller_profile.role != 'ORG_ADMIN'` — the same stale-role source as B, this
-- time on an RLS-bypassing function reachable straight from a browser.
--
-- CALLER SEARCH (origin/main, `src services packages sdks e2e tests`): ZERO
-- callers of the 3-argument form. `services/worker/src/api/queue-resolution.ts`
-- passes `p_caller_user_id`, which resolves to the 4-argument overload 0477
-- hardened; the only other hits are comments, agents.md notes, the generated
-- `database.types.ts` union, and `scripts/uat19/native-pg-queue-resolution.sh`
-- which calls the 4-arg form as service_role.
--
-- EXECUTE is therefore revoked from PUBLIC, anon and authenticated. The
-- function is NOT dropped: CLAUDE.md §6 warns about overload churn, a DROP
-- would need the exact argument list to stay unambiguous for PostgREST, and a
-- revoke is reversible in one statement.
--
-- -----------------------------------------------------------------------------
-- §1.4 SECURITY NOTES
--   - Both replaced functions keep SECURITY DEFINER + `SET search_path`.
--   - Supabase's `ALTER DEFAULT PRIVILEGES` re-grants anon/authenticated
--     EXECUTE on every `CREATE OR REPLACE`, which is the mechanism behind five
--     prior incidents (0364, 0377, 0378, 0388, 0406). Each replacement below is
--     immediately followed by its own `REVOKE ALL ... FROM PUBLIC, anon,
--     authenticated` and the correct `GRANT`, in that order.
--   - No grant is widened anywhere in this file.
--
-- ROLLBACK:
--   Runnable as written, top to bottom. To extract it as executable SQL:
--
--     awk '/^--   BEGIN;/{f=1} f{print} /^--   COMMIT;/{f=0}' \
--       supabase/migrations/0482_scrum5280_org_domain_verification_guard.sql \
--       | sed -E 's/^--( {1,3})?//' > rollback0482.sql
--
--   Verified on a native replay of the full schema: running the extracted file
--   restores `pg_proc.prosrc` for BOTH replaced functions byte-identically to
--   the 0429 / 0470 definitions (diff empty), and turns the five SCRUM-5280
--   regression tests red again. Re-applying 0482 turns them green.
--
--   ROLLING BACK RE-OPENS THE HOLE. After this block, any organization
--   administrator can again set `domain_verified = true` for a domain they do
--   not control and capture every later confirmed signup at that domain
--   (SCRUM-5280); `add_existing_org_member` again accepts an actor whose only
--   authority is a stale `profiles.role`; and
--   `resolve_anchor_queue_by_public_id(text,text,text)` is again callable by
--   `anon` and `authenticated`. Roll back only for a functional defect, and
--   re-apply as soon as that defect is fixed.
--
--   BEGIN;
--   SET LOCAL lock_timeout = '5s';
--
--   -- C. restore the 0399/0367-era ACL on the 3-argument overload
--   GRANT EXECUTE ON FUNCTION public.resolve_anchor_queue_by_public_id(text, text, text)
--     TO anon, authenticated;
--
--   -- A. 0429's protect_org_tenancy_fields(), copied VERBATIM from
--   --    0429_suborg_tenancy_foundations.sql (comments included, so the
--   --    restored pg_proc.prosrc is byte-identical to the pre-0482 body).
--   CREATE OR REPLACE FUNCTION public.protect_org_tenancy_fields()
--     RETURNS trigger
--     LANGUAGE plpgsql
--     SECURITY DEFINER
--     SET search_path TO 'public'
--   AS $$
--   DECLARE
--     caller_role text;
--   BEGIN
--     caller_role := get_caller_role();
--
--     -- Column guards apply to ordinary callers only. Trusted callers (the
--     -- worker's service_role client, platform operators) skip them -- but they do
--     -- NOT skip the re-parent reset below, which is an invariant rather than an
--     -- authorization rule and so is written once, after this block, for both
--     -- caller classes.
--     -- NULL-SAFE, and load-bearing. `get_caller_role()` returns NULL for an
--     -- ordinary authenticated caller (no `request.jwt.claim.role` GUC), so a bare
--     -- `NOT (caller_role = 'service_role' OR ...)` evaluates to NULL, the branch
--     -- does not execute, and EVERY column guard below silently becomes a no-op.
--     -- Caught by this PR's behaviour proof, which went 20/20 -> 15/20 on exactly
--     -- the negative-authority cases. Same three-valued-logic class as the
--     -- identity-guard fixes in 0380/0391/0392.
--     IF NOT (
--       coalesce(caller_role = 'service_role', false)
--       OR coalesce(is_current_user_platform_admin(), false)
--     ) THEN
--
--       -- Billing enforcement is never self-service: an org must not be able to
--       -- switch off the gate that bills it.
--       IF OLD.credit_enforcement_enabled IS DISTINCT FROM NEW.credit_enforcement_enabled THEN
--         RAISE EXCEPTION 'Cannot modify credit_enforcement_enabled directly'
--           USING ERRCODE = 'insufficient_privilege';
--       END IF;
--
--       -- Parent half of the consent: only an admin of the CURRENT parent org.
--       IF OLD.sub_org_listing_parent_optin IS DISTINCT FROM NEW.sub_org_listing_parent_optin THEN
--         IF OLD.parent_org_id IS NULL OR NOT is_org_admin_of(OLD.parent_org_id) THEN
--           RAISE EXCEPTION 'Only an admin of the parent organization may change sub_org_listing_parent_optin'
--             USING ERRCODE = 'insufficient_privilege';
--         END IF;
--       END IF;
--
--       -- Child half of the consent: an admin of THIS org who is not also an admin
--       -- of the parent. See the header note -- the parent admin is an org_members
--       -- owner of every affiliate it creates, so without the second clause one
--       -- party could sign both halves.
--       IF OLD.sub_org_listing_child_optin IS DISTINCT FROM NEW.sub_org_listing_child_optin THEN
--         IF NOT is_org_admin_of(OLD.id) THEN
--           RAISE EXCEPTION 'Only an admin of this organization may change sub_org_listing_child_optin'
--             USING ERRCODE = 'insufficient_privilege';
--         END IF;
--         IF OLD.parent_org_id IS NOT NULL AND is_org_admin_of(OLD.parent_org_id) THEN
--           RAISE EXCEPTION 'A parent-org admin may not supply the sub-organization''s own listing consent'
--             USING ERRCODE = 'insufficient_privilege';
--         END IF;
--       END IF;
--
--     END IF;
--
--     -- Consent is to a specific affiliation. Repointing the parent revokes both
--     -- halves, for EVERY caller. Runs after the guards above so an unrelated
--     -- re-parent by a trusted caller cannot trip the parent-consent check, and
--     -- last overall so it wins over any same-statement assignment.
--     IF OLD.parent_org_id IS DISTINCT FROM NEW.parent_org_id THEN
--       NEW.sub_org_listing_parent_optin := false;
--       NEW.sub_org_listing_child_optin  := false;
--     END IF;
--
--     RETURN NEW;
--   END;
--   $$;
--
--   ALTER FUNCTION public.protect_org_tenancy_fields() OWNER TO postgres;
--   REVOKE ALL ON FUNCTION public.protect_org_tenancy_fields() FROM PUBLIC, anon, authenticated;
--
--   -- B. 0470's add_existing_org_member(), copied VERBATIM from
--   --    0470_uat17_verified_domain_and_atomic_member_add.sql. The stale
--   --    profile-role fallback this migration removes is the THIRD
--   --    `NOT EXISTS` in the authorization block below -- restoring it is
--   --    exactly what re-opens defect B.
--   CREATE OR REPLACE FUNCTION public.add_existing_org_member(
--     p_actor_id uuid,
--     p_org_id uuid,
--     p_email text,
--     p_role text
--   ) RETURNS TABLE (
--     user_id uuid,
--     email text,
--     full_name text,
--     idempotent boolean
--   )
--   LANGUAGE plpgsql
--   SECURITY DEFINER
--   SET search_path = public
--   AS $$
--   DECLARE
--     v_target profiles%ROWTYPE;
--     v_member_role org_member_role;
--     v_existing_role org_member_role;
--     v_inserted boolean := false;
--     v_target_count integer;
--   BEGIN
--     IF public.get_caller_role() IS DISTINCT FROM 'service_role' THEN
--       RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
--     END IF;
--
--     IF p_actor_id IS NULL OR p_org_id IS NULL OR p_email IS NULL OR btrim(p_email) = '' THEN
--       RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
--     END IF;
--
--     IF p_role = 'INDIVIDUAL' THEN
--       v_member_role := 'member';
--     ELSIF p_role = 'ORG_ADMIN' THEN
--       v_member_role := 'admin';
--     ELSE
--       RAISE EXCEPTION 'invalid_role' USING ERRCODE = '22023';
--     END IF;
--
--     IF NOT EXISTS (
--       SELECT 1 FROM organizations o
--       WHERE o.id = p_org_id
--         AND o.suspended IS FALSE
--         AND coalesce(o.payment_state, 'ok') <> 'suspended'
--     ) THEN
--       RAISE EXCEPTION 'organization_unavailable' USING ERRCODE = '42501';
--     END IF;
--
--     IF NOT EXISTS (
--       SELECT 1 FROM profiles p
--       WHERE p.id = p_actor_id
--         AND p.deleted_at IS NULL
--         AND p.status = 'ACTIVE'
--     ) THEN
--       RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
--     END IF;
--
--     IF NOT EXISTS (
--       SELECT 1 FROM profiles p
--       WHERE p.id = p_actor_id
--         AND p.deleted_at IS NULL
--         AND p.is_platform_admin IS TRUE
--     ) AND NOT EXISTS (
--       SELECT 1 FROM org_members om
--       WHERE om.user_id = p_actor_id
--         AND om.org_id = p_org_id
--         AND om.role IN ('owner', 'admin')
--     ) AND NOT EXISTS (
--       SELECT 1 FROM profiles p
--       WHERE p.id = p_actor_id
--         AND p.deleted_at IS NULL
--         AND p.org_id = p_org_id
--         AND p.role = 'ORG_ADMIN'
--     ) THEN
--       RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
--     END IF;
--
--     SELECT count(*) INTO v_target_count
--     FROM profiles p
--     WHERE lower(p.email) = lower(btrim(p_email))
--       AND p.deleted_at IS NULL
--       AND p.status = 'ACTIVE';
--
--     IF v_target_count = 0 THEN
--       RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'P0002';
--     END IF;
--     IF v_target_count <> 1 THEN
--       RAISE EXCEPTION 'ambiguous_user' USING ERRCODE = 'P0003';
--     END IF;
--
--     SELECT p.* INTO STRICT v_target
--     FROM profiles p
--     WHERE lower(p.email) = lower(btrim(p_email))
--       AND p.deleted_at IS NULL
--       AND p.status = 'ACTIVE';
--
--     INSERT INTO org_members (user_id, org_id, role, invited_by)
--     VALUES (v_target.id, p_org_id, v_member_role, p_actor_id)
--     ON CONFLICT ON CONSTRAINT org_members_unique_membership DO NOTHING
--     RETURNING true INTO v_inserted;
--
--     v_inserted := coalesce(v_inserted, false);
--
--     IF NOT v_inserted THEN
--       SELECT om.role INTO v_existing_role
--       FROM org_members om
--       WHERE om.user_id = v_target.id
--         AND om.org_id = p_org_id;
--       IF v_existing_role IS DISTINCT FROM v_member_role THEN
--         RAISE EXCEPTION 'membership_role_conflict' USING ERRCODE = 'P0003';
--       END IF;
--     END IF;
--
--     IF v_inserted THEN
--       UPDATE profiles
--       SET org_id = p_org_id,
--           -- profiles.role is the immutable legacy primary-role projection. The
--           -- requested per-organization authority lives in org_members.role, so
--           -- never rewrite an existing profile role while backfilling org_id.
--           role = COALESCE(role, p_role::user_role),
--           role_set_at = CASE WHEN role IS NULL THEN now() ELSE role_set_at END
--       WHERE id = v_target.id
--         AND org_id IS NULL;
--
--       INSERT INTO audit_events (
--         event_type, event_category, actor_id, target_type, target_id, org_id, details
--       ) VALUES (
--         'MEMBER_ADDED', 'ORGANIZATION', p_actor_id, 'user', v_target.id::text,
--         p_org_id, json_build_object('role', v_member_role, 'via', 'org_admin_exact_email')::text
--       );
--     END IF;
--
--     RETURN QUERY SELECT v_target.id, v_target.email, v_target.full_name, NOT v_inserted;
--   END;
--   $$;
--
--   REVOKE ALL ON FUNCTION public.add_existing_org_member(uuid,uuid,text,text)
--     FROM PUBLIC, anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.add_existing_org_member(uuid,uuid,text,text)
--     TO service_role;
--
--   NOTIFY pgrst, 'reload schema';
--   COMMIT;
-- =============================================================================

BEGIN;

-- §1.2: `organizations` is a named hot table. Nothing below takes
-- AccessExclusiveLock on it (the trigger is not recreated), but the bound is
-- cheap and the 2026-08-11 P0 is what an unbounded wait costs.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- ─── A. organizations domain-verification write authority ───────────────────
-- 0429's body is preserved verbatim below; the only additions are the block
-- marked `-- 0482:`.

CREATE OR REPLACE FUNCTION public.protect_org_tenancy_fields()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  caller_role text;
  v_is_service_role boolean;
  v_old_domain text;
  v_new_domain text;
BEGIN
  caller_role := get_caller_role();

  -- NULL-SAFE, and load-bearing. `get_caller_role()` returns NULL for an
  -- ordinary authenticated caller (no `request.jwt.claim.role` GUC), so a bare
  -- `caller_role <> 'service_role'` evaluates to NULL and every guard below
  -- silently becomes a no-op. Same three-valued-logic class as 0380/0391/0392
  -- and as 0429's own note.
  v_is_service_role := coalesce(caller_role = 'service_role', false);

  -- ─ 0429 (unchanged): sub-org tenancy columns ─────────────────────────────
  -- Column guards apply to ordinary callers only. Trusted callers (the
  -- worker's service_role client, platform operators) skip them -- but they do
  -- NOT skip the re-parent reset below, which is an invariant rather than an
  -- authorization rule and so is written once, after this block, for both
  -- caller classes.
  IF NOT (
    v_is_service_role
    OR coalesce(is_current_user_platform_admin(), false)
  ) THEN

    -- Billing enforcement is never self-service: an org must not be able to
    -- switch off the gate that bills it.
    IF OLD.credit_enforcement_enabled IS DISTINCT FROM NEW.credit_enforcement_enabled THEN
      RAISE EXCEPTION 'Cannot modify credit_enforcement_enabled directly'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Parent half of the consent: only an admin of the CURRENT parent org.
    IF OLD.sub_org_listing_parent_optin IS DISTINCT FROM NEW.sub_org_listing_parent_optin THEN
      IF OLD.parent_org_id IS NULL OR NOT is_org_admin_of(OLD.parent_org_id) THEN
        RAISE EXCEPTION 'Only an admin of the parent organization may change sub_org_listing_parent_optin'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;

    -- Child half of the consent: an admin of THIS org who is not also an admin
    -- of the parent. See 0429's header -- the parent admin is an org_members
    -- owner of every affiliate it creates, so without the second clause one
    -- party could sign both halves.
    IF OLD.sub_org_listing_child_optin IS DISTINCT FROM NEW.sub_org_listing_child_optin THEN
      IF NOT is_org_admin_of(OLD.id) THEN
        RAISE EXCEPTION 'Only an admin of this organization may change sub_org_listing_child_optin'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF OLD.parent_org_id IS NOT NULL AND is_org_admin_of(OLD.parent_org_id) THEN
        RAISE EXCEPTION 'A parent-org admin may not supply the sub-organization''s own listing consent'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;

  END IF;

  -- ─ 0482 (SCRUM-5280): domain-verification columns ────────────────────────
  -- service_role ONLY -- see the header for why a platform-admin exemption is
  -- deliberately absent here while 0429's three columns keep theirs.
  IF NOT v_is_service_role THEN

    -- 0482: the six columns that together decide whether this organization
    -- owns `domain`. Verification is granted by the worker after proving
    -- control of the domain; asserting it is not an editable profile field.
    IF OLD.domain_verified IS DISTINCT FROM NEW.domain_verified THEN
      RAISE EXCEPTION 'Cannot modify domain_verified directly'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF OLD.domain_verification_method IS DISTINCT FROM NEW.domain_verification_method THEN
      RAISE EXCEPTION 'Cannot modify domain_verification_method directly'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF OLD.domain_verified_at IS DISTINCT FROM NEW.domain_verified_at THEN
      RAISE EXCEPTION 'Cannot modify domain_verified_at directly'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF OLD.verification_status IS DISTINCT FROM NEW.verification_status THEN
      RAISE EXCEPTION 'Cannot modify verification_status directly'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 0482: the stored token is the ONLY secret POST /api/v1/orgs/confirm-domain
    -- checks. Writing it is equivalent to writing domain_verified, one hop
    -- later and through the worker's own service_role client.
    IF OLD.domain_verification_token IS DISTINCT FROM NEW.domain_verification_token THEN
      RAISE EXCEPTION 'Cannot modify domain_verification_token directly'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF OLD.domain_verification_token_expires_at IS DISTINCT FROM NEW.domain_verification_token_expires_at THEN
      RAISE EXCEPTION 'Cannot modify domain_verification_token_expires_at directly'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 0482: editing the domain is allowed and DEMOTES the verification rather
    -- than raising -- `domain` is a legitimate EditableOrgFields column and the
    -- settings form re-sends it on every save. The comparison is normalized
    -- exactly as 0470's auto-association normalizes, and NULL-safe, so a no-op
    -- re-save of the same domain does not demote. Runs AFTER the guards above
    -- so an attempt to change the domain and re-assert verification in one
    -- statement still raises.
    v_old_domain := lower(trim(trailing '.' FROM OLD.domain));
    v_new_domain := lower(trim(trailing '.' FROM NEW.domain));
    IF v_old_domain IS DISTINCT FROM v_new_domain THEN
      NEW.domain_verified                        := false;
      NEW.domain_verification_method             := NULL;
      NEW.domain_verified_at                     := NULL;
      -- A token issued for the previous domain must not verify the new one.
      NEW.domain_verification_token              := NULL;
      NEW.domain_verification_token_expires_at   := NULL;
    END IF;

  END IF;

  -- Consent is to a specific affiliation. Repointing the parent revokes both
  -- halves, for EVERY caller. Runs after the guards above so an unrelated
  -- re-parent by a trusted caller cannot trip the parent-consent check, and
  -- last overall so it wins over any same-statement assignment.
  IF OLD.parent_org_id IS DISTINCT FROM NEW.parent_org_id THEN
    NEW.sub_org_listing_parent_optin := false;
    NEW.sub_org_listing_child_optin  := false;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.protect_org_tenancy_fields() OWNER TO postgres;

COMMENT ON FUNCTION public.protect_org_tenancy_fields() IS
  'SCRUM-3864 + SCRUM-5280: per-column write authority on organizations. organizations_update_admin grants an org admin UPDATE on every column of their own row, so the sub-org tenancy columns (0429) and the domain-verification columns (0482) each need their own guard. Verification state is service_role-only; changing the domain demotes the verification instead of blocking the edit.';

-- Supabase re-grants anon/authenticated EXECUTE on every CREATE OR REPLACE.
-- 0429 revoked and granted nothing (a trigger function needs no role grant);
-- that posture is reissued here rather than assumed.
REVOKE ALL ON FUNCTION public.protect_org_tenancy_fields() FROM PUBLIC, anon, authenticated;

-- The trigger is NOT recreated: `trg_protect_org_tenancy_fields` is already
-- `BEFORE UPDATE ON public.organizations FOR EACH ROW` with no column list
-- (0429), so it fires on a domain-only UPDATE. Recreating it would take an
-- AccessExclusiveLock on a hot table for no behavioural gain.

-- ─── B. add_existing_org_member — remove the stale profile-role fallback ────
-- Byte-identical to 0470 apart from the removed third `NOT EXISTS` branch,
-- marked `-- 0482:` below. Same signature, same argument names, same return
-- shape, so the deployed worker route is unaffected.

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

  -- 0482: exact membership is canonical. The third branch 0470 carried here --
  -- `profiles.org_id = p_org_id AND profiles.role = 'ORG_ADMIN'` -- is a
  -- stale-role fallback: profiles.role is the immutable legacy primary-role
  -- projection (see the UPDATE at the end of this function) and outlives a
  -- membership demotion, so a removed admin kept the authority to add members.
  -- 0477 removed the identical fallback from resolve_anchor_queue_by_public_id
  -- for the same reason.
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

-- ─── C. SCRUM-5282 — close the 3-argument queue-resolution overload ─────────
-- No CREATE OR REPLACE: the body is left exactly as 0399 defined it, so this
-- statement is the last thing to touch the ACL and cannot be undone by a
-- default-privileges re-grant in this file. The function is kept rather than
-- dropped (CLAUDE.md §6 overload churn), and a revoke reverses in one line.

REVOKE ALL ON FUNCTION public.resolve_anchor_queue_by_public_id(text, text, text)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.resolve_anchor_queue_by_public_id(text, text, text) IS
  'SCRUM-5282: RETIRED SURFACE. SECURITY DEFINER, authorizes on the stale profiles.role projection, and has no caller on origin/main -- the worker calls the four-argument overload hardened by 0477. EXECUTE revoked from PUBLIC, anon and authenticated by 0482; service_role retains it so the function is dormant rather than broken.';

NOTIFY pgrst, 'reload schema';

COMMIT;
