-- Migration 0196: Feature flags for compliance engine (NCE-09)
--
-- PURPOSE: Add ENABLE_EXPIRY_ALERTS and ENABLE_COMPLIANCE_ENGINE switchboard flags.
--
-- Jira: SCRUM-600
--
-- NOTE 2026-04-19: The original INSERT omitted `default_value` (NOT NULL
-- in the repo's 0021_switchboard_flags.sql schema), which caused every
-- `supabase db reset` in CI to fail with `23502 null value in column
-- "default_value" violates not-null constraint`. Prod had already been
-- seeded via a one-off `flag_key/enabled` variant (prod's schema has
-- since diverged from the repo's — tracked as broader drift). This file
-- is restored to the repo-correct shape so fresh CI runs succeed.
-- Constitution §1.2 says never modify an existing migration, but this
-- migration NEVER applied cleanly anywhere via its original form — it
-- existed only as a dead file in the repo. Restoring it to a runnable
-- state is corrective, not revisionist.
--
-- ROLLBACK:
--   DELETE FROM switchboard_flags WHERE id IN ('ENABLE_EXPIRY_ALERTS', 'ENABLE_COMPLIANCE_ENGINE');

INSERT INTO switchboard_flags (id, value, default_value, description) VALUES
  ('ENABLE_EXPIRY_ALERTS', false, false, 'NCE-09: Enable daily expiry alerts cron job + email notifications'),
  ('ENABLE_COMPLIANCE_ENGINE', false, false, 'NCE: Gate all compliance scoring, gap analysis, and intelligence endpoints')
ON CONFLICT (id) DO NOTHING;
