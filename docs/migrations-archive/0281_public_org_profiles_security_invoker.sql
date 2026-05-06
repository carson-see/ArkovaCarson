-- Migration 0281: SCRUM-1276 (R3-3) — public_org_profiles view → security_invoker
--
-- PURPOSE: convert `public_org_profiles` (created in 0160) to run with
-- `security_invoker = true` so RLS is evaluated against the calling user
-- (anon / authenticated) instead of the view owner (typically superuser).
-- Without this, the view ran as the owner and bypassed `organizations`
-- RLS — flagged by the SCRUM-1208 advisor and Forensic 7. The select
-- column list is already restricted to non-PII fields, but RLS bypass
-- means a hijacked column or future SELECT extension would leak across
-- tenants.
--
-- The CREATE OR REPLACE preserves the existing column list verbatim;
-- only the WITH clause is added. The companion baseline file
-- `scripts/ci/snapshots/views-security-invoker-baseline.json` will be
-- updated in the same PR to drop `public_org_profiles` from the
-- grandfathered set.
--
-- The other three grandfathered views (payment_ledger, v_slow_queries,
-- calibration_features) are addressed in their own follow-up migrations.
--
-- ROLLBACK:
--   CREATE OR REPLACE VIEW public_org_profiles AS
--     SELECT id, display_name, domain, description, website_url, logo_url,
--            founded_date, org_type, linkedin_url, twitter_url, location,
--            industry_tag, verification_status, created_at
--     FROM organizations;
--   (Restores the pre-0281 definer-rights behavior. Not provided as a
--   forward migration because reverting would re-open the cross-tenant leak.)

CREATE OR REPLACE VIEW public_org_profiles
WITH (security_invoker = true) AS
SELECT
  id,
  display_name,
  domain,
  description,
  website_url,
  logo_url,
  founded_date,
  org_type,
  linkedin_url,
  twitter_url,
  location,
  industry_tag,
  verification_status,
  created_at
FROM organizations;

COMMENT ON VIEW public_org_profiles IS
  'security_invoker=true (SCRUM-1276 / R3-3) — RLS evaluated against caller, '
  'not view owner. Field list intentionally excludes ein_tax_id, '
  'domain_verification_token, parent relationships, financial data.';

-- Defensive verification: confirm the option landed.
DO $$
DECLARE
  has_invoker bool;
BEGIN
  SELECT (c.reloptions @> ARRAY['security_invoker=true'])
    INTO has_invoker
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'public_org_profiles';

  IF has_invoker IS NOT TRUE THEN
    RAISE EXCEPTION 'SCRUM-1276: public_org_profiles missing security_invoker=true after 0281';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
