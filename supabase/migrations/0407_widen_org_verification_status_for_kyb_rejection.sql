-- 0407_widen_org_verification_status_for_kyb_rejection.sql
-- AUDIT-0424-10: widen organizations_verification_status_valid to admit the
-- terminal KYB outcomes the Middesk webhook already writes ('REJECTED',
-- 'REQUIRES_INPUT'). Until now the constraint admitted only
-- UNVERIFIED/PENDING/VERIFIED, so api/v1/webhooks/middesk.ts raised SQLSTATE
-- 23514 on every rejection — a KYB rejection could not be recorded at all, and
-- the checkout handler's `currentStatus === 'REJECTED'` guard was dead code.
--
-- Widening only. No existing row changes value; every currently-stored value
-- remains valid, so the ALTER validates without rewriting the table.
--
-- ROLLBACK:
--   -- Only safe while no row holds one of the two new values. Check first:
--   --   SELECT count(*) FROM public.organizations
--   --    WHERE verification_status IN ('REJECTED','REQUIRES_INPUT');
--   -- If that count is > 0, decide those orgs' dispositions before narrowing;
--   -- the ALTER below will fail rather than silently drop the states.
--   ALTER TABLE public.organizations
--     DROP CONSTRAINT IF EXISTS organizations_verification_status_valid;
--   ALTER TABLE public.organizations
--     ADD CONSTRAINT organizations_verification_status_valid
--     CHECK (verification_status = ANY (ARRAY['UNVERIFIED','PENDING','VERIFIED']));

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_verification_status_valid;

ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_verification_status_valid
  CHECK (
    verification_status = ANY (
      ARRAY['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED', 'REQUIRES_INPUT']
    )
  );

COMMENT ON COLUMN public.organizations.verification_status IS
  'Authoritative KYB state for the organization. Written ONLY by the KYB provider path (api/v1/webhooks/middesk.ts). Read as an entitlement gate by requireVerifiedOrg (docusign-oauth, drive-oauth), orgSubOrgs, and the useCanIssueCredential UI hook. Completing a Stripe checkout MUST NOT write this column — paying is not KYB evidence (AUDIT-0424-10). UNVERIFIED = no KYB attempted; PENDING = submitted, awaiting provider; VERIFIED/REJECTED/REQUIRES_INPUT = terminal provider outcomes.';

-- No DB function changed; PostgREST schema cache reload not required for a
-- CHECK constraint. Included for parity with the column comment refresh.
NOTIFY pgrst, 'reload schema';
