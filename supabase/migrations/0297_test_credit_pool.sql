-- 0297_test_credit_pool.sql
-- Jira: SCRUM-1740 (parent SCRUM-1734 partner sandbox playbook)
-- Purpose: Distinguish partner-sandbox test credits from production billing.
--          Adds `is_test` flag + `anchor_quota` cap to org_credits so the
--          billing layer can skip Stripe meter events for test orgs and
--          the anchor-submit endpoint can return 402 quota-exhausted when
--          a test org has consumed its provisioned anchor allowance.
-- Spec: https://arkova.atlassian.net/wiki/spaces/A/pages/43483138

-- ROLLBACK:
-- ALTER TABLE org_credits DROP COLUMN IF EXISTS anchor_quota;
-- ALTER TABLE org_credits DROP COLUMN IF EXISTS is_test;
-- DROP INDEX IF EXISTS idx_org_credits_is_test;

ALTER TABLE org_credits
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS anchor_quota integer;

COMMENT ON COLUMN org_credits.is_test IS
  'SCRUM-1740: when true, this org is a partner sandbox. Stripe meter events '
  'are suppressed and anchors count against `anchor_quota`. Default false so '
  'every existing row stays prod-billable.';

COMMENT ON COLUMN org_credits.anchor_quota IS
  'SCRUM-1740: total anchors this test org may create during the beta window. '
  'NULL means no cap (prod orgs). When set and exceeded, anchor-submit returns '
  'a 402 problem+json `quota-exhausted`. HakiChain pilot allocation: 10.';

-- Index for quick "is this org's quota exhausted" lookups in the
-- anchor-submit hot path. Partial index — we only ever query test orgs
-- through this column, so indexing the whole table would be waste.
CREATE INDEX IF NOT EXISTS idx_org_credits_is_test
  ON org_credits(org_id) WHERE is_test = true;

-- Refresh PostgREST schema cache so the new columns are visible to the API
-- without requiring a manual reload (per CLAUDE.md migration rule 3).
NOTIFY pgrst, 'reload schema';
