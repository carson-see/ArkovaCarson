-- 0380_f5_anchor_stats_fn_ownership_guard.sql
-- F-5 (docs/staging/SOAK-FINDINGS-2026-08.md, MEDIUM) — ownership-gate
--   get_org_anchor_stats(uuid) / get_user_anchor_stats(uuid).
--
-- THE HOLE THIS CLOSES:
--   Both functions are SECURITY DEFINER (RLS-bypassing, "STABLE ... SET
--   search_path TO 'public'") and accept a caller-supplied p_org_id /
--   p_user_id with NO check against the caller's actual identity. Any
--   authenticated (or, per the still-live anon grant, even unauthenticated)
--   PostgREST caller could pass an arbitrary org/user id and read that
--   org's/user's anchor counts (total/secured/pending) — cross-tenant
--   stats disclosure. A pentester would flag this immediately.
--
--   Migration 0378 explicitly deferred this exact pair (see its "NOT
--   REVOKED, NOTED FOR FOLLOW-UP" section, lines 33-40): revoking the grant
--   was the wrong fix vehicle because the live dashboard genuinely calls
--   both functions, and 0378 was an emergency grant-only pass with no soak
--   time to validate a body-level fix in the same change. This migration is
--   that follow-up.
--
-- CALL-SITE VERIFICATION (this session, both grep'd fresh):
--   src/: only caller is src/pages/DashboardPage.tsx:213
--     `(supabase as any).rpc(activeStatsRequest.rpcName, activeStatsRequest.rpcParam)`
--     where `activeStatsRequest` comes from
--     `resolveDashboardStatsRequest()` in src/lib/dashboardStats.ts:35-56:
--       - ORG_ADMIN branch → rpcName 'get_org_anchor_stats',
--         rpcParam `{ p_org_id: profileOrgId }` where `profileOrgId` is
--         `profile?.org_id` — the CALLER'S OWN org from their own profile
--         row, never another party's.
--       - fallback branch → rpcName 'get_user_anchor_stats',
--         rpcParam `{ p_user_id: userId }` where `userId` is `user?.id` —
--         the CALLER'S OWN auth session id.
--   services/worker/src/: NO call site for either function name (grep
--     across services/worker/src/ matches only the generated
--     services/worker/src/types/database.types.ts type declaration, not a
--     real `.rpc()` invocation).
--   Conclusion: the dashboard never passes anything but the caller's own
--   identity, so the ownership guard added below is fully additive from
--   the dashboard's perspective — it only rejects calls the dashboard was
--   never making in the first place.
--
-- PATTERN: mirrors the existing sibling
--   get_user_monthly_anchor_count(p_user_id uuid) guard already in the
--   baseline (BUG-2026-04-19-001 — "RAISES 42501 if p_user_id !=
--   auth.uid()."), extended with an explicit service_role bypass via
--   get_caller_role() (the PostgREST v11/v12-safe helper — see
--   CLAUDE.md §6 "current_setting('request.jwt.claim.role', true)' → use
--   get_caller_role()") for worker/admin callers using the service_role
--   client, where auth.uid() is always NULL. Org ownership uses
--   get_user_org_id() (`SELECT org_id FROM profiles WHERE id = auth.uid()`)
--   — the same helper the `anchors_select_org` RLS policy and the
--   dashboard's own ORG_ADMIN branch already key off, so "your org" means
--   exactly the same thing here as it does everywhere else in the schema.
--
-- Unauthorized callers get RAISE EXCEPTION ... USING ERRCODE = '42501'
-- (insufficient_privilege) — PostgREST surfaces this as a structured 403,
-- not a silent empty/zero JSON result — matching
-- get_user_monthly_anchor_count's existing convention for this exact bug
-- class rather than inventing a new failure shape.
--
-- Grants are UNCHANGED in this migration (authorization tightening only,
-- scoped to the function bodies) — the pre-existing anon/authenticated/
-- service_role grants stay as-is; the body-level guard now rejects any
-- anon call outright (auth.uid() and get_user_org_id() are both NULL for
-- an anon caller, so any real caller-supplied id is IS DISTINCT FROM NULL
-- → rejected) without needing a separate REVOKE pass.
--
-- ROLLBACK:
--   CREATE OR REPLACE FUNCTION "public"."get_org_anchor_stats"("p_org_id" "uuid") RETURNS "jsonb"
--       LANGUAGE "sql" STABLE SECURITY DEFINER
--       SET "search_path" TO 'public'
--       AS $$
--     SELECT jsonb_build_object(
--       'total', COUNT(*) FILTER (WHERE TRUE),
--       'secured', COUNT(*) FILTER (WHERE status = 'SECURED'),
--       'pending', COUNT(*) FILTER (WHERE status = 'PENDING')
--     )
--     FROM anchors
--     WHERE org_id = p_org_id
--       AND deleted_at IS NULL
--       AND (metadata->>'pipeline_source') IS NULL;
--   $$;
--   ALTER FUNCTION "public"."get_org_anchor_stats"("p_org_id" "uuid") OWNER TO "postgres";
--   COMMENT ON FUNCTION "public"."get_org_anchor_stats"("p_org_id" "uuid") IS NULL;
--
--   CREATE OR REPLACE FUNCTION "public"."get_user_anchor_stats"("p_user_id" "uuid") RETURNS "jsonb"
--       LANGUAGE "sql" STABLE SECURITY DEFINER
--       SET "search_path" TO 'public'
--       AS $$
--     SELECT jsonb_build_object(
--       'total', COUNT(*) FILTER (WHERE TRUE),
--       'secured', COUNT(*) FILTER (WHERE status = 'SECURED'),
--       'pending', COUNT(*) FILTER (WHERE status = 'PENDING')
--     )
--     FROM anchors
--     WHERE user_id = p_user_id
--       AND deleted_at IS NULL
--       AND (metadata->>'pipeline_source') IS NULL;
--   $$;
--   ALTER FUNCTION "public"."get_user_anchor_stats"("p_user_id" "uuid") OWNER TO "postgres";
--   COMMENT ON FUNCTION "public"."get_user_anchor_stats"("p_user_id" "uuid") IS NULL;
--
--   NOTIFY pgrst, 'reload schema';
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION "public"."get_org_anchor_stats"("p_org_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF get_caller_role() IS DISTINCT FROM 'service_role'
     AND p_org_id IS DISTINCT FROM get_user_org_id() THEN
    RAISE EXCEPTION 'unauthorized: p_org_id must match the caller''s own org'
      USING ERRCODE = '42501';
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
  'F-5 (SOAK-FINDINGS-2026-08.md): anchor counts for the calling org member''s own org. SECURITY DEFINER bypasses RLS. RAISES 42501 if p_org_id != get_user_org_id() (service_role exempt).';

CREATE OR REPLACE FUNCTION "public"."get_user_anchor_stats"("p_user_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF get_caller_role() IS DISTINCT FROM 'service_role'
     AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'unauthorized: p_user_id must match auth.uid()'
      USING ERRCODE = '42501';
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
  'F-5 (SOAK-FINDINGS-2026-08.md): anchor counts for the calling user''s own anchors. SECURITY DEFINER bypasses RLS. RAISES 42501 if p_user_id != auth.uid() (service_role exempt).';

-- Reload PostgREST schema cache so the new function bodies take effect on
-- the API surface immediately (function catalog is cached by PostgREST).
NOTIFY pgrst, 'reload schema';

COMMIT;
