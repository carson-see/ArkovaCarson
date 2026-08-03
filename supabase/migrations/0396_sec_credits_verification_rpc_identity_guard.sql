-- 0396_sec_credits_verification_rpc_identity_guard.sql
-- SEC — two SECURITY DEFINER RPCs missed by the F-5/F-5b/F-5c sweep
-- (0380/0391/0392, docs/staging/SOAK-FINDINGS-2026-08.md F-5) and by the
-- REVOKE sweeps (0364/0377/0378). Found this session via a deliberate repeat
-- of that sweep's methodology (grep every SECURITY DEFINER function taking a
-- caller-suppliable identity param, cross-reference current live grants and
-- body).
--
-- ===========================================================================
-- BUG 1 — public.get_user_credits(p_user_id uuid DEFAULT NULL): UNAUTHENTICATED
--   cross-tenant credit/plan/billing disclosure, plus an attacker-triggered
--   row-seeding WRITE. Baseline body (never redefined since 2026-04-19):
--
--     v_user_id := COALESCE(p_user_id, auth.uid());
--
--   `p_user_id` wins outright over the caller's real identity whenever it is
--   supplied — there is no comparison against `auth.uid()` at all, not even
--   the NULL-unsafe `IS DISTINCT FROM` shape F-5 had. This is WORSE than F-5:
--   `credits` table RLS (`credits_select`, baseline line 12705) restricts
--   direct PostgREST table reads to `auth.uid() = user_id`, but this function
--   is SECURITY DEFINER and bypasses that RLS entirely, so it is a full
--   bypass of a real, working RLS policy — not a defense-in-depth gap on top
--   of one.
--
--   Grants are `anon` + `authenticated` + `service_role` (baseline lines
--   14046-14048), UNCHANGED by any later migration (`grep -rln
--   get_user_credits supabase/migrations/*.sql` returns only the baseline).
--   Because the function accepts an explicit `p_user_id` argument and never
--   checks it, an `anon` PostgREST caller — no session, no login, just the
--   public `anon` API key already shipped in the frontend bundle — gets:
--     - `balance`, `monthly_allocation`, `purchased`, `plan_name` (Free /
--       Individual / Professional — a billing-tier fact), `cycle_start`,
--       `cycle_end`, `is_low` for ANY existing user id.
--     - a WRITE side effect when the target has no `credits` row yet: an
--       `INSERT INTO credits (...)` seed row plus an `INSERT INTO
--       credit_transactions (..., 'ALLOCATION', ...)` audit row, keyed to an
--       id the caller does not own and never authenticated as. Bounded by
--       `credits.user_id REFERENCES auth.users(id)` (confirmed live on the
--       local dev stack this session via `\d credits`) — the target id must
--       be a real, already-provisioned auth user, not an arbitrary UUID.
--
--   CALL-SITE VERIFICATION (this session, grep'd fresh):
--     src/: only caller is src/hooks/useCredits.ts:33-38
--       `fetchCreditsData(userId)` -> `.rpc('get_user_credits', { p_user_id:
--       userId })`, invoked from `useQuery({ queryFn: () =>
--       fetchCreditsData(user!.id), enabled: !!user })` — ALWAYS the calling
--       session's OWN `user.id` from `useAuth()`, never another party's, and
--       never called while logged out (`enabled: !!user`).
--     services/worker/src/: NO call site (grep across services/worker/src/
--       matches only the generated services/worker/src/types/database.types.ts
--       type declaration, not a real `.rpc()` invocation) — so the
--       `service_role` bypass added below is additive, matching 0380/0391's
--       own finding for the sibling stats functions.
--   Conclusion: the guard below rejects only calls the product never makes.
--
-- FIX: same NULL-safe ownership-guard idiom as 0391/0392 (resolve identity
--   into a local, reject NULL, THEN compare) — required by
--   `scripts/ci/check-null-identity-guard.ts` (FIRST_ENFORCED_PREFIX = 393,
--   so this file, prefix 396, is in-scope). `p_user_id` keeps its DEFAULT
--   NULL / "omit means self" contract: NULL is allowed through (resolves to
--   the caller's own id via COALESCE), an explicit id matching the caller is
--   allowed, anything else raises 42501. `service_role` bypass preserved
--   (worker/admin tooling with no session identity). SCRUM-1278: the sole
--   `auth.uid()` reference is wrapped as `(SELECT auth.uid())` (initplan
--   cached; satisfies `scripts/ci/check-rls-auth-uid-wrap.ts`). Every
--   downstream line (subscription/plan lookup, credits row seed, return
--   shape) is byte-identical to the current body — this is an authorization
--   change only, no grant change for this function.
--
-- ===========================================================================
-- BUG 2 — public.is_user_verified(p_user_id uuid): anon-reachable KYC-status
--   side door. Baseline body (never redefined since 2026-04-19):
--
--     SELECT COALESCE((SELECT identity_verification_status = 'verified'
--       FROM profiles WHERE id = p_user_id), false);
--
--   Zero identity check of any kind. Grants are `anon` + `authenticated` +
--   `service_role` (baseline lines 14125-14127), unchanged by any later
--   migration. Any `anon` or `authenticated` caller can enumerate whether an
--   arbitrary `profiles.id` has completed KYC verification.
--
--   This directly contradicts the public-profile projection this codebase
--   otherwise maintains: `get_public_member_profile` (baseline lines
--   3616-3618) SELECTs `id, public_id, full_name, avatar_url, bio,
--   social_links, created_at` — `identity_verification_status` is
--   deliberately NOT in that allow-list. `is_user_verified` leaks the same
--   field through a side door the allow-list was never applied to.
--
--   CALL-SITE VERIFICATION (this session): `grep -rn is_user_verified src/
--   services/` (both source trees, both `*.ts`/`*.tsx`) matches ONLY the
--   generated `database.types.ts` signature declaration in both
--   `src/types/` and `services/worker/src/types/` — zero real `.rpc()`
--   invocation anywhere, frontend or worker.
--
-- FIX: unlike BUG 1, there is no real caller to preserve an ownership
--   contract for, so this follows the 0364/0377/0378 precedent for
--   zero-caller unguarded SECURITY DEFINER RPCs — REVOKE the `anon` and
--   `authenticated` grants outright rather than invent guard semantics for a
--   call shape nobody makes. `service_role` keeps EXECUTE (unchanged; no
--   worker caller exists today either, but this mirrors 0378's own
--   conservative "leave service_role for a function whose future intent is
--   plausibly internal" choice rather than fully dropping it).
--
--   MUST also revoke `PUBLIC`, not just `anon`/`authenticated`: PostgreSQL
--   grants EXECUTE to the PUBLIC pseudo-role by default at function creation
--   time, and every real role (anon/authenticated included) is implicitly a
--   member of PUBLIC — confirmed live on the local dev stack this session
--   (`information_schema.routine_privileges` lists a `PUBLIC | EXECUTE` row
--   for both functions in this file, alongside the explicit anon/
--   authenticated/service_role grants). Revoking only anon/authenticated
--   while leaving PUBLIC granted would be a no-op fix — anon/authenticated
--   callers would still execute via their PUBLIC membership. 0364's own
--   header names this explicitly ("REVOKE FROM PUBLIC is defensive: it
--   strips the implicit default-PUBLIC grant") and every REVOKE in
--   0364/0377/0378/0388 targets `FROM PUBLIC, anon, authenticated` in one
--   statement — matched here.
--
-- SCOPE: neither GRANT/REVOKE below touches `get_user_credits` (guard is
--   body-only, same convention as 0380/0391/0392) or `credits`/`profiles`
--   table RLS (unchanged, already correct — this closes a bypass OF that
--   RLS, not a hole IN it).
--
-- ROLLBACK:
--   CREATE OR REPLACE FUNCTION "public"."get_user_credits"("p_user_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
--       LANGUAGE "plpgsql" SECURITY DEFINER
--       SET "search_path" TO 'public'
--       AS $$
--   DECLARE
--     v_user_id uuid;
--     v_credits credits%ROWTYPE;
--     v_plan_name text;
--     v_plan_allocation integer;
--   BEGIN
--     v_user_id := COALESCE(p_user_id, auth.uid());
--     IF v_user_id IS NULL THEN
--       RETURN jsonb_build_object('error', 'User not found');
--     END IF;
--
--     SELECT * INTO v_credits FROM credits WHERE user_id = v_user_id;
--
--     SELECT p.name, CASE p.name
--       WHEN 'Free' THEN 50
--       WHEN 'Individual' THEN 500
--       WHEN 'Professional' THEN 5000
--       ELSE 50
--     END
--     INTO v_plan_name, v_plan_allocation
--     FROM subscriptions s
--     JOIN plans p ON s.plan_id = p.id
--     WHERE s.user_id = v_user_id
--       AND s.status IN ('active', 'trialing')
--     ORDER BY s.created_at DESC
--     LIMIT 1;
--
--     IF v_plan_name IS NULL THEN
--       v_plan_name := 'Free';
--       v_plan_allocation := 50;
--     END IF;
--
--     IF v_credits.id IS NULL THEN
--       INSERT INTO credits (user_id, balance, monthly_allocation, cycle_start, cycle_end)
--       VALUES (
--         v_user_id,
--         v_plan_allocation,
--         v_plan_allocation,
--         date_trunc('month', now()),
--         (date_trunc('month', now()) + interval '1 month')
--       )
--       ON CONFLICT (user_id) DO NOTHING
--       RETURNING * INTO v_credits;
--
--       IF v_credits.id IS NULL THEN
--         SELECT * INTO v_credits FROM credits WHERE user_id = v_user_id;
--       END IF;
--
--       INSERT INTO credit_transactions (user_id, transaction_type, amount, balance_after, reason)
--       VALUES (v_user_id, 'ALLOCATION', v_plan_allocation, v_plan_allocation, 'Initial credit allocation');
--     END IF;
--
--     RETURN jsonb_build_object(
--       'balance', v_credits.balance,
--       'monthly_allocation', v_plan_allocation,
--       'purchased', v_credits.purchased,
--       'plan_name', v_plan_name,
--       'cycle_start', v_credits.cycle_start,
--       'cycle_end', v_credits.cycle_end,
--       'is_low', v_credits.balance < 10
--     );
--   END;
--   $$;
--   ALTER FUNCTION "public"."get_user_credits"("p_user_id" "uuid") OWNER TO "postgres";
--   COMMENT ON FUNCTION "public"."get_user_credits"("p_user_id" "uuid") IS NULL;
--
--   GRANT ALL ON FUNCTION "public"."is_user_verified"("p_user_id" "uuid") TO PUBLIC, "anon", "authenticated";
--
--   NOTIFY pgrst, 'reload schema';
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION "public"."get_user_credits"("p_user_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user_id uuid;
  v_caller_id uuid;
  v_credits credits%ROWTYPE;
  v_plan_name text;
  v_plan_allocation integer;
BEGIN
  IF get_caller_role() IS DISTINCT FROM 'service_role' THEN
    v_caller_id := (SELECT auth.uid());

    -- Reject a NULL caller identity BEFORE comparing arguments (F-5b idiom —
    -- `IS DISTINCT FROM` silently absorbs NULL-vs-NULL, which is exactly how
    -- an anon caller supplying an explicit p_user_id slipped through before:
    -- there was no NULL check AND no comparison at all).
    IF v_caller_id IS NULL THEN
      RAISE EXCEPTION 'unauthorized: caller is not authenticated'
        USING ERRCODE = '42501';
    END IF;

    -- p_user_id keeps its "omit means self" contract: only an EXPLICIT
    -- mismatched id is rejected. NULL falls through to the COALESCE below and
    -- resolves to the caller's own id, matching every real call site
    -- (src/hooks/useCredits.ts always passes the caller's own auth id).
    IF p_user_id IS NOT NULL AND p_user_id IS DISTINCT FROM v_caller_id THEN
      RAISE EXCEPTION 'unauthorized: p_user_id must match the caller''s own auth id'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  v_user_id := COALESCE(p_user_id, v_caller_id);
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'User not found');
  END IF;

  SELECT * INTO v_credits FROM credits WHERE user_id = v_user_id;

  SELECT p.name, CASE p.name
    WHEN 'Free' THEN 50
    WHEN 'Individual' THEN 500
    WHEN 'Professional' THEN 5000
    ELSE 50
  END
  INTO v_plan_name, v_plan_allocation
  FROM subscriptions s
  JOIN plans p ON s.plan_id = p.id
  WHERE s.user_id = v_user_id
    AND s.status IN ('active', 'trialing')
  ORDER BY s.created_at DESC
  LIMIT 1;

  IF v_plan_name IS NULL THEN
    v_plan_name := 'Free';
    v_plan_allocation := 50;
  END IF;

  IF v_credits.id IS NULL THEN
    INSERT INTO credits (user_id, balance, monthly_allocation, cycle_start, cycle_end)
    VALUES (
      v_user_id,
      v_plan_allocation,
      v_plan_allocation,
      date_trunc('month', now()),
      (date_trunc('month', now()) + interval '1 month')
    )
    ON CONFLICT (user_id) DO NOTHING
    RETURNING * INTO v_credits;

    IF v_credits.id IS NULL THEN
      SELECT * INTO v_credits FROM credits WHERE user_id = v_user_id;
    END IF;

    INSERT INTO credit_transactions (user_id, transaction_type, amount, balance_after, reason)
    VALUES (v_user_id, 'ALLOCATION', v_plan_allocation, v_plan_allocation, 'Initial credit allocation');
  END IF;

  RETURN jsonb_build_object(
    'balance', v_credits.balance,
    'monthly_allocation', v_plan_allocation,
    'purchased', v_credits.purchased,
    'plan_name', v_plan_name,
    'cycle_start', v_credits.cycle_start,
    'cycle_end', v_credits.cycle_end,
    'is_low', v_credits.balance < 10
  );
END;
$$;

ALTER FUNCTION "public"."get_user_credits"("p_user_id" "uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."get_user_credits"("p_user_id" "uuid") IS
  'SEC (0396): credit/plan info for the calling user''s own account. SECURITY DEFINER bypasses the credits_select RLS policy. RAISES 42501 if the caller is unauthenticated or p_user_id does not match the caller''s own auth id (service_role exempt; NULL p_user_id resolves to caller''s own id).';

-- BUG 2: no legitimate anon/authenticated caller exists (see header) — revoke
-- outright rather than invent guard semantics for a call shape nobody makes.
-- FROM PUBLIC is required, not optional: PostgreSQL's implicit default-PUBLIC
-- EXECUTE grant otherwise leaves anon/authenticated able to call the function
-- via their PUBLIC membership even after their own explicit grants are gone
-- (confirmed live this session; matches 0364/0377/0378/0388's own convention).
REVOKE ALL ON FUNCTION "public"."is_user_verified"("p_user_id" "uuid") FROM PUBLIC, "anon", "authenticated";

COMMENT ON FUNCTION "public"."is_user_verified"("p_user_id" "uuid") IS
  'SEC (0396): Check if a user has completed KYC verification (IDT WS1). PUBLIC/anon/authenticated EXECUTE revoked 2026-08 — no real caller exists (grep-verified) and identity_verification_status is deliberately excluded from the public profile projection (get_public_member_profile); service_role retained.';

-- Reload PostgREST schema cache so the new function body + grants take effect
-- on the API surface immediately (function catalog is cached by PostgREST).
NOTIFY pgrst, 'reload schema';

COMMIT;
