-- SCRUM-1241 (AUDIT-0424-17): defensive uniqueness on org_integrations
-- when account_id is null.
--
-- The base table (migration 0251) already declares
-- `UNIQUE (org_id, provider, account_id)`. That is sufficient when
-- `account_id` is NOT NULL — Postgres treats two NULLs as distinct, so
-- two rows with the same (org_id, provider) but null account_id slip
-- past the constraint. Currently the OAuth callback always populates
-- account_id, but defensive defense-in-depth: enforce one-active-row
-- per (org_id, provider) when account_id is null AND the integration
-- is still live (revoked_at IS NULL). This prevents:
--   1. Two parallel callbacks racing to insert before account_id is
--      resolved leaving two ghost active rows.
--   2. A future code path inserting with account_id null colliding
--      across orgs.
--
-- This is additive — does not relax the existing 3-tuple uniqueness.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_org_integrations_org_provider_active_null_account;

CREATE UNIQUE INDEX IF NOT EXISTS idx_org_integrations_org_provider_active_null_account
  ON org_integrations (org_id, provider)
  WHERE revoked_at IS NULL AND account_id IS NULL;

COMMENT ON INDEX idx_org_integrations_org_provider_active_null_account IS
  'SCRUM-1241 / AUDIT-0424-17: enforces one active integration per (org_id, provider) when account_id is null. Defense-in-depth atop the base UNIQUE (org_id, provider, account_id) which permits multiple null-account_id rows because Postgres treats NULLs as distinct.';

NOTIFY pgrst, 'reload schema';
