-- SCRUM-5294 / AR20-13: give the service-only materialization recovery
-- ledger the repository's canonical restrictive policy identity.
--
-- 0498 already enables and forces RLS, revokes all client grants, and leaves
-- service_role with SELECT only. This explicit deny-all policy closes the
-- R3-2 policy-census gap without making any recovery evidence readable or
-- writable to a user session. The SECURITY DEFINER recovery RPC remains the
-- only writer.
--
-- ROLLBACK: forward-only. Retain this restrictive policy with the immutable
-- 0498 recovery ledger. A future removal would weaken defense in depth and
-- must be separately reviewed; application rollback requires no SQL change.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE POLICY mfa_verified_authenticated
  ON public.agent_webhook_materialization_recoveries
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

COMMENT ON POLICY mfa_verified_authenticated
  ON public.agent_webhook_materialization_recoveries IS
  'Deny-all by design (R3-2). Service-only immutable recovery evidence: anon and authenticated may never read or mutate rows; only the audited SECURITY DEFINER recovery RPC writes and service_role has read-only inspection.';

NOTIFY pgrst, 'reload schema';
COMMIT;
