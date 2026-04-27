-- Migration 0276: SELECT policy for switchboard_flags so platform admins
-- can read flags from the browser.
--
-- Why: switchboard_flags has FORCE RLS but only deny-write policies, no
-- permissive SELECT — every authenticated read returned [], so the
-- /admin/controls page rendered no toggles even for platform admins.
-- Service role bypasses RLS, so the worker is unaffected.
--
-- auth.uid() is wrapped in (SELECT …) so Postgres caches the call once per
-- statement instead of evaluating it per row (pattern from migration 0190).
--
-- ROLLBACK: DROP POLICY IF EXISTS switchboard_flags_select_platform_admin ON public.switchboard_flags;

BEGIN;

CREATE POLICY switchboard_flags_select_platform_admin ON public.switchboard_flags
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = (SELECT auth.uid()) AND is_platform_admin = true
    )
  );

NOTIFY pgrst, 'reload schema';

COMMIT;
