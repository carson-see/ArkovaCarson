-- Migration 0196: Feature flags for compliance engine (NCE-09)
--
-- PURPOSE: Add ENABLE_EXPIRY_ALERTS and ENABLE_COMPLIANCE_ENGINE switchboard flags.
--
-- Jira: SCRUM-600
--
-- ROLLBACK:
--   DELETE FROM switchboard_flags WHERE id IN ('ENABLE_EXPIRY_ALERTS', 'ENABLE_COMPLIANCE_ENGINE');

INSERT INTO switchboard_flags (id, value, description) VALUES
  ('ENABLE_EXPIRY_ALERTS', false, 'NCE-09: Enable daily expiry alerts cron job + email notifications'),
  ('ENABLE_COMPLIANCE_ENGINE', false, 'NCE: Gate all compliance scoring, gap analysis, and intelligence endpoints')
ON CONFLICT (id) DO NOTHING;
