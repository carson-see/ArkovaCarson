CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type TEXT NOT NULL
    CHECK (type IN ('REGULATORY_CHANGE', 'AUDIT_COMPLETED', 'BREACH_ALERT')),
  severity TEXT NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org members can read their org notifications" ON notifications;
CREATE POLICY "Org members can read their org notifications"
  ON notifications FOR SELECT USING (
    org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Org admins can mark notifications read" ON notifications;
CREATE POLICY "Org admins can mark notifications read"
  ON notifications FOR UPDATE USING (
    org_id IN (
      SELECT org_id FROM org_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

CREATE INDEX IF NOT EXISTS idx_notifications_org_unread
  ON notifications (org_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_org_recent
  ON notifications (org_id, created_at DESC);

NOTIFY pgrst, 'reload schema';;
