-- SCRUM-5024 / PR #2905: keep new referral tables behind the mandatory MFA boundary.
-- Migration 0451 applied its restrictive predicate to the tables that existed
-- then. The two tables created later by 0455 need the same predicate. Existing
-- tenant/platform-admin policies still decide which verified users may read;
-- this restrictive policy grants no additional row access or table privilege.
-- No rows, columns, function signatures or generated types change.
--
-- ROLLBACK: reverting this migration alone would reopen direct AAL1 access.
-- Contain direct table access by revoking authenticated privileges instead;
-- service-role operations and all stored referral data remain available:
-- BEGIN;
-- SET LOCAL lock_timeout = '5s';
-- REVOKE ALL ON TABLE public.referral_codes, public.organization_referrals FROM authenticated;
-- COMMIT;
-- To re-enable after reapplying this migration, restore only 0455's reviewed
-- SELECT grants (not INSERT/UPDATE/DELETE) to authenticated.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY IF EXISTS mfa_verified_authenticated ON public.referral_codes;
CREATE POLICY mfa_verified_authenticated ON public.referral_codes
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (private.is_human_mfa_verified())
  WITH CHECK (private.is_human_mfa_verified());

DROP POLICY IF EXISTS mfa_verified_authenticated ON public.organization_referrals;
CREATE POLICY mfa_verified_authenticated ON public.organization_referrals
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (private.is_human_mfa_verified())
  WITH CHECK (private.is_human_mfa_verified());

NOTIFY pgrst, 'reload schema';
COMMIT;
