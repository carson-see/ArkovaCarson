-- 0392_f5c_monthly_anchor_count_null_identity_guard.sql
-- F-5c — closes the last instance of the F-5b NULL-identity guard idiom.
--   public.get_user_monthly_anchor_count(uuid) is the third and final function
--   in the schema carrying `p_x IS DISTINCT FROM <identity-fn>()` with no
--   NULL pre-check. The other two were fixed by 0391 (F-5b, PR #1871).
--
-- SEVERITY — LATENT, NOT CURRENTLY EXPLOITABLE. Read this before triaging.
--   Verified live against prod (vzwyaatejekddvltxyye, 2026-08-02):
--     has_function_privilege('anon', ...)          = FALSE
--     has_function_privilege('authenticated', ...) = TRUE
--     has_function_privilege('service_role', ...)  = TRUE
--   The NULL-vs-NULL collapse only fires for a caller whose auth id is NULL.
--   anon cannot execute this function at all, and every *authenticated*
--   caller has a non-NULL auth id, so `NULL IS DISTINCT FROM <uuid>` is TRUE
--   and the guard already raises correctly for them. There is therefore NO
--   reachable bypass today — this is not a pen-test finding.
--
--   What it IS: a trap one GRANT away from going live. The moment anyone
--   grants anon EXECUTE (which is exactly the state the 0391 pair was in),
--   `get_user_monthly_anchor_count(NULL)` from an anonymous caller would
--   return a count instead of 42501. Closing it now removes the trap rather
--   than relying on nobody ever widening the grant.
--
-- WHY A COMPENSATING MIGRATION:
--   The function is defined in the SCRUM-1668 Path C baseline
--   (00000000000000_baseline_at_main_HEAD.sql:4221) and has never been
--   redefined by any later migration. The baseline is immutable
--   (CLAUDE.md §1.2 / supabase/migrations/agents.md hard rules), so the fix
--   is a forward CREATE OR REPLACE here.
--
-- THREE DEFECTS FIXED, not one:
--   1. NULL-identity collapse (the F-5b class) — reject a NULL caller
--      identity BEFORE comparing arguments.
--   2. NO service_role bypass. Every sibling guard in this family exempts
--      service_role via get_caller_role(); this one never did. Because the
--      worker's auth id is always NULL, a service_role caller passing a real
--      p_user_id hits `<uuid> IS DISTINCT FROM NULL` = TRUE and is REJECTED.
--      That makes the function unusable from the worker today. No worker call
--      site exists right now (the only caller is the browser hook
--      src/hooks/useEntitlements.ts:75, which passes the caller's own id), so
--      this is a latent blocker being removed pre-emptively, not an active
--      outage being repaired — stated precisely so nobody reads this as a
--      production incident.
--   3. Bare `auth.uid()` (SCRUM-1278). Now `(SELECT auth.uid())`, consistent
--      with 0380/0391 and with scripts/ci/check-rls-auth-uid-wrap.ts.
--
-- BEHAVIOUR PRESERVED EXACTLY:
--   * The count query is byte-identical: count(*)::integer over anchors
--     WHERE user_id = p_user_id AND created_at >= date_trunc('month', now()).
--     Note it deliberately has NO deleted_at / pipeline_source filter — that
--     is the existing quota semantics (BUG-2026-04-19-001) and is NOT changed
--     here. A compensating security migration is the wrong vehicle for a
--     billing-semantics change.
--   * RETURNS integer, LANGUAGE plpgsql, STABLE, SECURITY DEFINER,
--     SET search_path TO 'public', OWNER postgres.
--   * Grants. No GRANT/REVOKE in this file — anon stays without EXECUTE.
--
-- CALLER IMPACT: none for the live path. src/hooks/useEntitlements.ts:75 calls
--   this with `{ p_user_id: userId }` where userId is the caller's own auth id
--   under an authenticated session, which passes both new checks unchanged.
--   (That hook swallows RPC errors and degrades to 0, so a regression here
--   would silently under-report usage rather than surface — an extra reason to
--   keep the happy path provably intact; the live test suite asserts it.)
--
-- ROLLBACK:
--   Restores the exact pre-0392 body as captured from prod via
--   pg_get_functiondef on 2026-08-02. BREAK-GLASS ONLY: rolling back
--   reinstates the NULL-identity trap, the missing service_role bypass, and
--   the bare auth.uid().
--
--   BEGIN;
--   CREATE OR REPLACE FUNCTION "public"."get_user_monthly_anchor_count"("p_user_id" "uuid") RETURNS integer
--       LANGUAGE "plpgsql" STABLE SECURITY DEFINER
--       SET "search_path" TO 'public'
--       AS $$
--   DECLARE
--     v_count integer;
--   BEGIN
--     IF p_user_id IS DISTINCT FROM auth.uid() THEN
--       RAISE EXCEPTION 'unauthorized: p_user_id must match auth.uid()'
--         USING ERRCODE = '42501';
--     END IF;
--
--     SELECT count(*)::integer INTO v_count FROM anchors
--     WHERE user_id = p_user_id
--       AND created_at >= date_trunc('month', now());
--
--     RETURN v_count;
--   END;
--   $$;
--   ALTER FUNCTION "public"."get_user_monthly_anchor_count"("p_user_id" "uuid") OWNER TO "postgres";
--   COMMENT ON FUNCTION "public"."get_user_monthly_anchor_count"("p_user_id" "uuid") IS
--     'BUG-2026-04-19-001: count of this-month anchors for the calling user. SECURITY DEFINER bypasses RLS. RAISES 42501 if p_user_id != auth.uid().';
--
--   NOTIFY pgrst, 'reload schema';
--   COMMIT;
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION "public"."get_user_monthly_anchor_count"("p_user_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_id uuid;
  v_count integer;
BEGIN
  IF get_caller_role() IS DISTINCT FROM 'service_role' THEN
    -- SCRUM-1278 lint compliance: this runs once per call (PL/pgSQL scalar
    -- assignment in a SECURITY DEFINER function that bypasses RLS), so the
    -- wrap is convention and consistency with 0380/0391, not a per-row win.
    v_caller_id := (SELECT auth.uid());

    -- F-5c: reject an unauthenticated caller BEFORE comparing arguments.
    -- Without this, a caller whose auth id is NULL passing an explicit NULL
    -- p_user_id hit `NULL IS DISTINCT FROM NULL` = FALSE and skipped the
    -- raise. Not reachable today (anon has no EXECUTE grant), but it would
    -- become reachable the moment that grant were widened.
    IF v_caller_id IS NULL THEN
      RAISE EXCEPTION 'unauthorized: caller is not authenticated'
        USING ERRCODE = '42501';
    END IF;

    IF p_user_id IS DISTINCT FROM v_caller_id THEN
      RAISE EXCEPTION 'unauthorized: p_user_id must match the caller''s own auth id'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT count(*)::integer INTO v_count FROM anchors
  WHERE user_id = p_user_id
    AND created_at >= date_trunc('month', now());

  RETURN v_count;
END;
$$;

ALTER FUNCTION "public"."get_user_monthly_anchor_count"("p_user_id" "uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."get_user_monthly_anchor_count"("p_user_id" "uuid") IS
  'BUG-2026-04-19-001 / F-5c: count of this-month anchors for the calling user. SECURITY DEFINER bypasses RLS. RAISES 42501 if the caller is unauthenticated (incl. when p_user_id is NULL) or if p_user_id does not match the caller''s own auth id. service_role exempt.';

-- Reload PostgREST schema cache so the new body takes effect on the API
-- surface immediately (function catalog is cached by PostgREST).
NOTIFY pgrst, 'reload schema';

COMMIT;
