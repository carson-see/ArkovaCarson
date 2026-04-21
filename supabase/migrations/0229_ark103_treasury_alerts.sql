-- Migration 0229: ARK-103 — treasury_alert_state singleton for dedup
--
-- PURPOSE
-- -------
-- The treasury-alert cron fires every 5 min and needs to remember its
-- last-fire time + threshold-crossing state so it doesn't spam the
-- Slack channel. A singleton key/value table is enough — we just need
-- one row per alert kind.
--
-- Table lives here rather than in a generic `system_state` table to
-- keep the cron-specific RLS posture narrow (service-role-only writes).
--
-- JIRA: SCRUM-1013 (ARK-103)
-- EPIC: SCRUM-1010 (CIBA)
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS treasury_alert_state;

CREATE TABLE treasury_alert_state (
  key                    TEXT PRIMARY KEY,
  below_threshold        BOOLEAN NOT NULL DEFAULT false,
  last_balance_usd       NUMERIC(20, 4),
  last_reason            TEXT,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT treasury_alert_state_key_length
    CHECK (char_length(key) BETWEEN 1 AND 64)
);

COMMENT ON TABLE treasury_alert_state IS
  'ARK-103 dedup state. Singleton keyed by alert kind (currently "low_balance").';

ALTER TABLE treasury_alert_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE treasury_alert_state FORCE ROW LEVEL SECURITY;

-- Platform admins can read for ops visibility; writes are service-role only.
GRANT SELECT ON treasury_alert_state TO authenticated;

CREATE POLICY treasury_alert_state_select ON treasury_alert_state
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'PLATFORM_ADMIN'
    )
  );

NOTIFY pgrst, 'reload schema';
