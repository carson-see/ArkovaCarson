INSERT INTO switchboard_flags (flag_key, enabled, description) VALUES
  ('ENABLE_EXPIRY_ALERTS', false, 'NCE-09: Enable daily expiry alerts cron job + email notifications'),
  ('ENABLE_COMPLIANCE_ENGINE', false, 'NCE: Gate all compliance scoring, gap analysis, and intelligence endpoints')
ON CONFLICT (flag_key) DO NOTHING;;
