-- 0402 — retire `public.activate_user(text, text)`.
--
-- Companion to the worker-side fix in `services/worker/src/api/activation.ts`
-- (same PR). Exactly the same shape, and for exactly the same reason, as 0401
-- retiring `create_pending_recipient`: an account-provisioning step that SQL
-- structurally cannot perform is replaced by a loud, self-documenting raise
-- pointing at the worker endpoint that can.
--
-- ===========================================================================
-- THE BUG (two independent failures; account activation was 100% broken)
--
-- 1. WRONG SIGNATURE AT THE CALL SITE. `src/pages/ActivateAccountPage.tsx:44`
--    called:
--
--        supabase.rpc('activate_user', { p_token, p_claim_key })
--
--    Production has exactly ONE overload —
--    `activate_user(p_token text, p_password text)` (baseline
--    `00000000000000_baseline_at_main_HEAD.sql:498`). PostgREST binds
--    overloads by argument NAME, so `p_claim_key` could never resolve and
--    every activation attempt returned PGRST202.
--
--    The `p_claim_key` variant exists ONLY in
--    `docs/migrations-archive/0175_activate_user_function.sql` — archived and
--    never deployed. Confirming it is genuinely absent, not merely renamed:
--    the live schema has no `activation_tokens` table and no `claim_key`
--    column anywhere (`grep -n 'activation_tokens\|claim_key' ` over the
--    baseline returns nothing). The deployed activation path instead uses
--    `profiles.activation_token` / `profiles.activation_token_expires_at`
--    (baseline:9014-9015).
--
-- 2. THE PASSWORD WAS SILENTLY DISCARDED. The deployed body accepts
--    `p_password` and never references it again (baseline:498-553) — it only
--    flips `status` to 'ACTIVE' and NULLs the token. So even with (1)
--    corrected, no password was ever set on the recipient's `auth.users` row
--    and they still could not sign in. Fixing the call site alone would have
--    produced a *silently* broken flow (a green "Account Activated!" screen
--    followed by a login that can never succeed) — strictly worse to diagnose
--    than the PGRST202 it replaced.
--
-- ===========================================================================
-- WHY THIS IS NOT "FIXED" IN SQL
--
-- Setting a password means writing GoTrue-owned state: the password hash, the
-- `auth.identities` rows and the confirmation flags. That is the Supabase
-- admin API's job (`auth.admin.updateUserById`), which requires the
-- service_role key — and Constitution §1.4 forbids that key ever reaching the
-- browser, so it cannot be done client-side either. A SECURITY DEFINER
-- function hand-writing `auth.users` would mint exactly the half-formed,
-- cannot-authenticate accounts that 0401's header rejects for the same
-- reason. The correct path is the worker's `completeActivation`, mirroring
-- `invitations.ts` (SCRUM-3012), which already solves the identical
-- "unauthenticated holder of an emailed token needs an account provisioned"
-- problem.
--
-- ===========================================================================
-- WHAT THIS MIGRATION DOES
--
-- 1. Replaces the body with a `RAISE EXCEPTION` naming the worker endpoint.
--    This CANNOT regress any working caller: the ONLY runtime caller was the
--    frontend line above, which already failed 100% of the time with
--    PGRST202. It also stops a future session from "fixing" the call site to
--    pass `p_password` — which would resolve, return `{"success": true}`, and
--    still never set a password.
--
-- 2. SECURITY: revokes the browser-reachable grants. The baseline granted
--    this SECURITY DEFINER `profiles` writer to BOTH `anon` and
--    `authenticated` (baseline:13479-13481). An `anon`-callable function that
--    flips `profiles.status` to ACTIVE and consumes activation tokens has no
--    business being reachable from a browser session at all — it let any
--    unauthenticated party burn a recipient's activation token straight from
--    the public anon key, with no rate limiting in front of it. (Not
--    practically brute-forceable — the token is 256 bits — but the grant is
--    wrong regardless, and the retired body is now the only thing behind it.)
--    `REVOKE ... FROM PUBLIC` is named explicitly because a PUBLIC
--    pseudo-role grant would make an anon/authenticated-only revoke a no-op
--    (the catch documented in 0364's header). `service_role` is retained so
--    the revoke cannot lock out an operator path.
--
-- Signature is unchanged, so there is no `database.types.ts` delta.
--
-- Blast radius: none for working traffic. Verified zero non-frontend callers:
--   grep -rn "activate_user" src services --include=*.ts --include=*.tsx
-- returns only the generated `database.types.ts` entries in `src/types/` and
-- `services/worker/src/types/`, plus the one broken call site this PR
-- repoints at `POST /api/activation/complete`.
--
-- Tier: T3 (touches supabase/migrations/).
--
-- ROLLBACK:
--   -- Restore the original (broken) baseline body and grants:
--   CREATE OR REPLACE FUNCTION public.activate_user(p_token text, p_password text)
--   RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
--   SET search_path TO 'public', 'pg_temp' AS $rollback$
--   DECLARE
--     pending_profile RECORD;
--   BEGIN
--     SELECT * INTO pending_profile FROM profiles
--     WHERE activation_token = p_token AND status = 'PENDING_ACTIVATION';
--     IF NOT FOUND THEN
--       RETURN jsonb_build_object('success', false, 'error', 'Invalid or expired activation token');
--     END IF;
--     IF pending_profile.activation_token_expires_at < now() THEN
--       RETURN jsonb_build_object('success', false, 'error', 'Activation token has expired. Please contact your organization administrator.');
--     END IF;
--     UPDATE profiles SET status = 'ACTIVE', activation_token = NULL,
--       activation_token_expires_at = NULL, updated_at = now()
--     WHERE id = pending_profile.id;
--     INSERT INTO audit_events (event_type, event_category, actor_id, org_id,
--       target_type, target_id, details)
--     VALUES ('USER_ACTIVATED', 'USER', pending_profile.id, pending_profile.org_id,
--       'profile', pending_profile.id::text,
--       jsonb_build_object('email', pending_profile.email)::text);
--     RETURN jsonb_build_object('success', true, 'email', pending_profile.email,
--       'profile_id', pending_profile.id);
--   END;
--   $rollback$;
--   GRANT ALL ON FUNCTION public.activate_user(text, text) TO authenticated;
--   GRANT ALL ON FUNCTION public.activate_user(text, text) TO anon;
--   GRANT ALL ON FUNCTION public.activate_user(text, text) TO service_role;
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.activate_user(
  p_token text,
  p_password text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  -- This RPC can never activate an account. It ignored `p_password` entirely,
  -- so it marked the profile ACTIVE while leaving the `auth.users` row with no
  -- password — the recipient could never sign in. SQL cannot fix that: the
  -- password hash, `auth.identities` and confirmation state are GoTrue's, and
  -- reaching them needs the service_role admin API, which must never be
  -- exposed to a browser (Constitution 1.4). Fail loudly instead of
  -- half-activating an account that cannot authenticate.
  RAISE EXCEPTION
    'activate_user is retired: it never set a password, so activated accounts could not sign in. Use the worker endpoint POST /api/activation/complete (services/worker/src/api/activation.ts).'
    USING ERRCODE = 'feature_not_supported';
END;
$$;

COMMENT ON FUNCTION public.activate_user(text, text) IS
  'RETIRED (0402). Always raises. It ignored p_password, so activation left auth.users without a password and the recipient could not sign in; setting a password requires the service_role admin API. Use POST /api/activation/complete.';

-- A SECURITY DEFINER writer of `profiles` must never be browser-callable.
-- PUBLIC is named explicitly: a PUBLIC grant would make an anon/authenticated-only
-- revoke a no-op.
REVOKE ALL ON FUNCTION public.activate_user(text, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.activate_user(text, text)
  TO service_role;
