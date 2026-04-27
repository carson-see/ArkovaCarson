-- =============================================================================
-- Migration 0276: Add SELECT policy on switchboard_flags for platform admins.
--
-- /admin/controls renders the master platform switchboard. Today the page
-- shows ONLY "Quick Actions" because the GET on switchboard_flags returns
-- [] for any authenticated user — the table has 20 rows but FORCE RLS is
-- on and there is NO permissive SELECT policy. The three existing policies
-- (`*_no_user_writes`, `*_no_user_updates`, `*_no_user_deletes`) only deny
-- writes; without a SELECT policy authenticated users see zero rows.
--
-- This migration adds a permissive SELECT policy gated to platform admins
-- (matching the same audience that can mutate flags via the worker's
-- /api/admin/* endpoints — service_role on the worker side).
--
-- Service role keeps full SELECT via the existing schema grants and bypasses
-- RLS, so the worker is unaffected.
--
-- ROLLBACK: DROP POLICY IF EXISTS switchboard_flags_select_platform_admin ON public.switchboard_flags;
-- =============================================================================

BEGIN;

CREATE POLICY switchboard_flags_select_platform_admin ON public.switchboard_flags
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND is_platform_admin = true
    )
  );

NOTIFY pgrst, 'reload schema';

COMMIT;
