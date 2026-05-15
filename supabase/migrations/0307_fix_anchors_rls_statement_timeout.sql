-- ROLLBACK: Re-create original three separate policies (see bottom of file)
--
-- Fix: anchors_select_platform_admin RLS policy causes full-table scan
--
-- Problem: Three permissive SELECT policies on `anchors` are ORed by Postgres:
--   1. anchors_select_own:            user_id = auth.uid()
--   2. anchors_select_org:            org_id = get_user_org_id()
--   3. anchors_select_platform_admin: is_current_user_platform_admin()
--
-- Policy 3 has NO column predicate — just a function call returning boolean.
-- Postgres cannot use any index for this OR branch. With 2.87M rows / 22 GB,
-- the planner falls back to sequential scan and hits statement_timeout.
--
-- Fix: Consolidate into a single policy with scalar subquery wrappers.
-- Wrapping function calls in (SELECT ...) forces Postgres to evaluate them
-- as InitPlans (once per statement), then constant-fold the results into the
-- WHERE clause. For non-admin users this becomes:
--   WHERE user_id = 'x' OR org_id = 'y' OR false
-- which the planner can service with a BitmapOr of two index scans.
--
-- For admin users it becomes:
--   WHERE user_id = 'x' OR org_id = 'y' OR true
-- simplifying to WHERE true (full access, correct behavior).

BEGIN;

DROP POLICY IF EXISTS "anchors_select_own" ON "public"."anchors";
DROP POLICY IF EXISTS "anchors_select_org" ON "public"."anchors";
DROP POLICY IF EXISTS "anchors_select_platform_admin" ON "public"."anchors";

-- Create consolidated policy with scalar subquery wrappers for InitPlan evaluation
CREATE POLICY "anchors_select" ON "public"."anchors"
  FOR SELECT TO "authenticated"
  USING (
    user_id = (SELECT auth.uid())
    OR org_id = (SELECT public.get_user_org_id())
    OR (SELECT public.is_current_user_platform_admin())
  );

COMMENT ON POLICY "anchors_select" ON "public"."anchors"
  IS 'Consolidated SELECT policy: own records, org records, or platform admin. '
     'Scalar subquery wrappers force InitPlan evaluation to enable index usage. '
     'Replaces anchors_select_own + anchors_select_org + anchors_select_platform_admin.';

-- Apply the same fix to attestations (same pattern: standalone platform_admin policy)
DROP POLICY IF EXISTS "attestations_select_platform_admin" ON "public"."attestations";

-- The existing attestations_select policy already has user + org + subject checks.
-- Merge admin access into it by adding the admin OR branch.
DROP POLICY IF EXISTS "attestations_select" ON "public"."attestations";
CREATE POLICY "attestations_select" ON "public"."attestations"
  FOR SELECT TO "authenticated"
  USING (
    attester_user_id = (SELECT auth.uid())
    OR attester_org_id = (SELECT public.get_user_org_id())
    OR (EXISTS (
      SELECT 1 FROM public.anchors a
      WHERE a.id = anchor_id AND a.user_id = (SELECT auth.uid())
    ))
    OR (SELECT public.is_current_user_platform_admin())
  );

COMMENT ON POLICY "attestations_select" ON "public"."attestations"
  IS 'Consolidated SELECT: attester, org, anchor owner, or platform admin. '
     'Scalar subquery wrappers force InitPlan evaluation. '
     'Replaces attestations_select + attestations_select_platform_admin.';

-- Reload PostgREST schema cache so the policy change takes effect immediately
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ROLLBACK SQL (manual — paste into a compensating migration if needed):
--
-- DROP POLICY IF EXISTS "anchors_select" ON "public"."anchors";
-- CREATE POLICY "anchors_select_own" ON "public"."anchors"
--   FOR SELECT TO "authenticated"
--   USING (user_id = (SELECT auth.uid()));
-- CREATE POLICY "anchors_select_org" ON "public"."anchors"
--   FOR SELECT TO "authenticated"
--   USING (org_id = public.get_user_org_id());
-- CREATE POLICY "anchors_select_platform_admin" ON "public"."anchors"
--   FOR SELECT TO "authenticated"
--   USING (public.is_current_user_platform_admin());
-- NOTIFY pgrst, 'reload schema';
