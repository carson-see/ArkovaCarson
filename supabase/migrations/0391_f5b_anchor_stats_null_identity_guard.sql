-- 0391_f5b_anchor_stats_null_identity_guard.sql
-- F-5b — COMPENSATING migration for 0380_f5_anchor_stats_fn_ownership_guard.sql.
--   Closes a NULL-identity bypass in the ownership guard 0380 added to
--   public.get_org_anchor_stats(uuid) / public.get_user_anchor_stats(uuid).
--
-- Renumbered 0389 -> 0391: #1862 renumbered onto 0389 and #1841 onto 0390 while
-- this was being written. First claim wins (supabase/migrations/agents.md).
--
-- WHY A COMPENSATING MIGRATION AND NOT AN EDIT TO 0380:
--   0380 is already applied to production (vzwyaatejekddvltxyye) ahead of its
--   owning PR #1778 landing on main (migrate-before-merge; the prod ledger row
--   is carried as an in-flight orphan in
--   scripts/ci/snapshots/ledger-numeric-exemptions.json). Editing an applied
--   migration would put the repo file out of sync with the deployed schema —
--   CLAUDE.md §1.2, "never modify an existing migration — write a compensating
--   one." PR #1778 reached the same conclusion in commit c4cead96f, which
--   documents this exact edge as "left unpatched deliberately ... closing it
--   needs a compensating migration." This is that migration.
--
-- THE HOLE THIS CLOSES:
--   0380's guard is:
--
--     IF get_caller_role() IS DISTINCT FROM 'service_role'
--        AND p_org_id IS DISTINCT FROM get_user_org_id() THEN
--       RAISE EXCEPTION ... USING ERRCODE = '42501';
--     END IF;
--
--   For a caller with no identity, get_user_org_id() (and the caller's auth id
--   in the sibling function) evaluates to NULL. If that caller passes an
--   explicit NULL argument, the comparison becomes `NULL IS DISTINCT FROM
--   NULL`, which is FALSE — so the RAISE is skipped and the function falls
--   through to the query, returning HTTP 200 with
--   {"total":0,"secured":0,"pending":0}.
--
--   Two caller classes reach this, not one:
--     (a) anon — the anon EXECUTE grant on both functions is still live
--         (baseline; 0378 deliberately did not revoke it because the live
--         dashboard is a real caller), and neither the caller's auth id nor
--         get_user_org_id() resolves for an anon PostgREST caller.
--     (b) an AUTHENTICATED user with no org — profiles.org_id IS NULL (the
--         INDIVIDUAL role; e.g. seed user demo-user@arkova.local). For them
--         get_user_org_id() is NULL too, so get_org_anchor_stats(NULL) also
--         slipped the org guard.
--
-- SEVERITY — NOT a data disclosure:
--   `WHERE org_id = NULL` / `WHERE user_id = NULL` is never true for any row
--   (SQL NULL comparison), so no cross-tenant row is reachable and the counts
--   returned are structurally always zero. This is a RESPONSE-SHAPE defect:
--   an unauthorized call is indistinguishable from an authorized empty result.
--   That "silent success" shape is exactly what 0380 set out to eliminate
--   (its own header: PostgREST surfaces 42501 as "a structured 403, not a
--   silent empty/zero JSON result"), and it is the kind of finding an external
--   pen test writes up on sight.
--
-- THE FIX:
--   Reject a NULL caller identity outright, before the argument comparison, so
--   an unauthenticated (or org-less) caller gets 42501 regardless of what it
--   passes. Deriving the identity into a local and testing it explicitly is
--   what makes the NULL case unmissable — the bug in 0380 exists precisely
--   because `IS DISTINCT FROM` silently absorbs NULL-vs-NULL.
--
-- SCRUM-1278: the caller's auth id is read as `(SELECT auth.uid())`, wrapped so
--   Postgres caches the JWT lookup as an initplan instead of re-evaluating it
--   per row (scripts/ci/check-rls-auth-uid-wrap.ts; per-row evaluation on the
--   1.4M-row anchors table contributed to the 2026-04-25 outage). This matches
--   0380's current tip, which adopted the wrap in commit 46860ca27.
--
-- PRESERVED FROM 0380 (deliberately unchanged):
--   * service_role bypass via get_caller_role() — worker/admin callers, whose
--     auth id is always NULL, must still pass. Note that this bypass is what
--     makes the NULL-identity check safe to add: the only callers with no auth
--     identity that have a legitimate reason to call these functions are
--     service_role, and they are exempted before the check is reached.
--   * SECURITY DEFINER, STABLE, SET search_path TO 'public'.
--   * The exact stats shape: total/secured/pending over non-deleted,
--     non-pipeline anchors.
--   * Grants. This migration contains no GRANT/REVOKE — authorization
--     tightening is in-body only, same as 0380.
--
-- NOT A REGRESSION FOR THE DASHBOARD:
--   The only caller is src/pages/DashboardPage.tsx:213 via
--   resolveDashboardStatsRequest() (src/lib/dashboardStats.ts:35-56), which
--   takes the ORG branch only under `profileRole === 'ORG_ADMIN' && profileOrgId`
--   — i.e. it cannot call get_org_anchor_stats with a NULL/absent org, and its
--   typed contract is `rpcParam: { p_org_id: string }` (non-nullable). An
--   org-less user is routed to get_user_anchor_stats with their own auth id.
--   So every call the dashboard actually makes carries a non-NULL identity
--   that matches the caller. The rejections added here are calls the product
--   never makes.
--
-- SELF-CONTAINED BY DESIGN:
--   Both function bodies below are written out in full (CREATE OR REPLACE),
--   not as a delta against 0380. 0380's .sql lives on PR #1778's branch and is
--   not yet on main, so this migration must produce the correct final state on
--   a fresh `supabase db reset` whether or not 0380 has landed. Ordering is
--   safe in every case because 0391 > 0380: on a fresh DB 0380 runs first and
--   is superseded here; on prod/staging 0380 is already applied and this
--   replaces it; if #1778 were abandoned entirely, this file alone still
--   installs the fully guarded bodies.
--
-- ROLLBACK:
--   Restores 0380's bodies exactly as they stand at that branch's current tip
--   (origin/fix/f5-stats-fn-ownership, incl. the SCRUM-1278 wrap from 46860ca27).
--   BREAK-GLASS ONLY: rolling back reinstates the NULL-identity bypass
--   described above. Prefer fixing forward.
--
--   BEGIN;
--   CREATE OR REPLACE FUNCTION "public"."get_org_anchor_stats"("p_org_id" "uuid") RETURNS "jsonb"
--       LANGUAGE "plpgsql" STABLE SECURITY DEFINER
--       SET "search_path" TO 'public'
--       AS $$
--   BEGIN
--     IF get_caller_role() IS DISTINCT FROM 'service_role'
--        AND p_org_id IS DISTINCT FROM get_user_org_id() THEN
--       RAISE EXCEPTION 'unauthorized: p_org_id must match the caller''s own org'
--         USING ERRCODE = '42501';
--     END IF;
--
--     RETURN (
--       SELECT jsonb_build_object(
--         'total', COUNT(*) FILTER (WHERE TRUE),
--         'secured', COUNT(*) FILTER (WHERE status = 'SECURED'),
--         'pending', COUNT(*) FILTER (WHERE status = 'PENDING')
--       )
--       FROM anchors
--       WHERE org_id = p_org_id
--         AND deleted_at IS NULL
--         AND (metadata->>'pipeline_source') IS NULL
--     );
--   END;
--   $$;
--   ALTER FUNCTION "public"."get_org_anchor_stats"("p_org_id" "uuid") OWNER TO "postgres";
--   COMMENT ON FUNCTION "public"."get_org_anchor_stats"("p_org_id" "uuid") IS
--     'F-5 (SOAK-FINDINGS-2026-08.md): anchor counts for the calling org member''s own org. SECURITY DEFINER bypasses RLS. RAISES 42501 if p_org_id != get_user_org_id() (service_role exempt).';
--
--   CREATE OR REPLACE FUNCTION "public"."get_user_anchor_stats"("p_user_id" "uuid") RETURNS "jsonb"
--       LANGUAGE "plpgsql" STABLE SECURITY DEFINER
--       SET "search_path" TO 'public'
--       AS $$
--   BEGIN
--     IF get_caller_role() IS DISTINCT FROM 'service_role'
--        AND p_user_id IS DISTINCT FROM (SELECT auth.uid()) THEN
--       RAISE EXCEPTION 'unauthorized: p_user_id must match the caller''s own auth id'
--         USING ERRCODE = '42501';
--     END IF;
--
--     RETURN (
--       SELECT jsonb_build_object(
--         'total', COUNT(*) FILTER (WHERE TRUE),
--         'secured', COUNT(*) FILTER (WHERE status = 'SECURED'),
--         'pending', COUNT(*) FILTER (WHERE status = 'PENDING')
--       )
--       FROM anchors
--       WHERE user_id = p_user_id
--         AND deleted_at IS NULL
--         AND (metadata->>'pipeline_source') IS NULL
--     );
--   END;
--   $$;
--   ALTER FUNCTION "public"."get_user_anchor_stats"("p_user_id" "uuid") OWNER TO "postgres";
--   COMMENT ON FUNCTION "public"."get_user_anchor_stats"("p_user_id" "uuid") IS
--     'F-5 (SOAK-FINDINGS-2026-08.md): anchor counts for the calling user''s own anchors. SECURITY DEFINER bypasses RLS. RAISES 42501 if p_user_id does not match the caller''s own auth id (service_role exempt).';
--
--   NOTIFY pgrst, 'reload schema';
--   COMMIT;
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION "public"."get_org_anchor_stats"("p_org_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_org_id uuid;
BEGIN
  IF get_caller_role() IS DISTINCT FROM 'service_role' THEN
    v_caller_org_id := get_user_org_id();

    -- F-5b: reject a NULL caller identity BEFORE comparing arguments.
    -- Without this, an anon (or org-less authenticated) caller passing an
    -- explicit NULL p_org_id hit `NULL IS DISTINCT FROM NULL` = FALSE, skipped
    -- the raise below, and got a 200 + all-zero JSON instead of a 403.
    IF v_caller_org_id IS NULL THEN
      RAISE EXCEPTION 'unauthorized: caller has no org identity'
        USING ERRCODE = '42501';
    END IF;

    IF p_org_id IS DISTINCT FROM v_caller_org_id THEN
      RAISE EXCEPTION 'unauthorized: p_org_id must match the caller''s own org'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'total', COUNT(*) FILTER (WHERE TRUE),
      'secured', COUNT(*) FILTER (WHERE status = 'SECURED'),
      'pending', COUNT(*) FILTER (WHERE status = 'PENDING')
    )
    FROM anchors
    WHERE org_id = p_org_id
      AND deleted_at IS NULL
      AND (metadata->>'pipeline_source') IS NULL
  );
END;
$$;

ALTER FUNCTION "public"."get_org_anchor_stats"("p_org_id" "uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."get_org_anchor_stats"("p_org_id" "uuid") IS
  'F-5/F-5b (SOAK-FINDINGS-2026-08.md): anchor counts for the calling org member''s own org. SECURITY DEFINER bypasses RLS. RAISES 42501 if the caller has no org identity (anon or org-less user, incl. when p_org_id is NULL) or if p_org_id != get_user_org_id(). service_role exempt.';

CREATE OR REPLACE FUNCTION "public"."get_user_anchor_stats"("p_user_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_id uuid;
BEGIN
  IF get_caller_role() IS DISTINCT FROM 'service_role' THEN
    -- SCRUM-1278: wrapped so the JWT lookup is cached as an initplan rather
    -- than re-evaluated per row.
    v_caller_id := (SELECT auth.uid());

    -- F-5b: reject an unauthenticated caller BEFORE comparing arguments.
    -- Without this, an anon caller passing an explicit NULL p_user_id hit
    -- `NULL IS DISTINCT FROM NULL` = FALSE and got a 200 + all-zero JSON.
    IF v_caller_id IS NULL THEN
      RAISE EXCEPTION 'unauthorized: caller is not authenticated'
        USING ERRCODE = '42501';
    END IF;

    IF p_user_id IS DISTINCT FROM v_caller_id THEN
      RAISE EXCEPTION 'unauthorized: p_user_id must match the caller''s own auth id'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'total', COUNT(*) FILTER (WHERE TRUE),
      'secured', COUNT(*) FILTER (WHERE status = 'SECURED'),
      'pending', COUNT(*) FILTER (WHERE status = 'PENDING')
    )
    FROM anchors
    WHERE user_id = p_user_id
      AND deleted_at IS NULL
      AND (metadata->>'pipeline_source') IS NULL
  );
END;
$$;

ALTER FUNCTION "public"."get_user_anchor_stats"("p_user_id" "uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."get_user_anchor_stats"("p_user_id" "uuid") IS
  'F-5/F-5b (SOAK-FINDINGS-2026-08.md): anchor counts for the calling user''s own anchors. SECURITY DEFINER bypasses RLS. RAISES 42501 if the caller is unauthenticated (incl. when p_user_id is NULL) or if p_user_id does not match the caller''s own auth id. service_role exempt.';

-- Reload PostgREST schema cache so the new function bodies take effect on the
-- API surface immediately (function catalog is cached by PostgREST).
NOTIFY pgrst, 'reload schema';

COMMIT;
