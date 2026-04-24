-- SCRUM-1093: Notification center — schema + event types
-- ROLLBACK: DROP TABLE IF EXISTS notifications; DROP TYPE IF EXISTS notification_type;

CREATE TYPE notification_type AS ENUM (
  'queue_run_completed',
  'rule_fired',
  'version_available_for_review',
  'treasury_alert',
  'anchor_revoked'
);

CREATE TABLE user_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  type notification_type NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user_read ON user_notifications (user_id, read_at);
CREATE INDEX idx_notifications_org ON user_notifications (organization_id);
CREATE INDEX idx_notifications_created ON user_notifications (created_at DESC);

ALTER TABLE user_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_notifications FORCE ROW LEVEL SECURITY;

CREATE POLICY notifications_select_own ON user_notifications
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY notifications_update_own ON user_notifications
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY notifications_service_insert ON user_notifications
  FOR INSERT WITH CHECK (
    get_caller_role() = 'service_role'
  );

NOTIFY pgrst, 'reload schema';
