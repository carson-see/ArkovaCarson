-- Migration 0218: notifications table for NCA-06 in-app notifications.
--
-- PURPOSE: Store in-app notifications fired by the NCA-06 regulatory-change
-- cron (and any future system-triggered events). Org admins see these in the
-- notification feed; they persist until `read_at` is set.
--
-- The NCA-06 cron writes rows here with `type = 'REGULATORY_CHANGE'` when a
-- compliance-score drop of ≥5 points is detected after a rule update. Rows
-- are retained indefinitely so history is available for audit.
--
-- Jira: SCRUM-761 (NCA-06)
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS notifications;

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Event classification for filter/grouping. Extend the CHECK when new
  -- notification types are added — a shared UI component consumes this.
  type TEXT NOT NULL
    CHECK (type IN ('REGULATORY_CHANGE', 'AUDIT_COMPLETED', 'BREACH_ALERT')),
  severity TEXT NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  -- Optional deep-link into the app (e.g. /compliance/scorecard).
  link TEXT,
  -- Freeform payload for the consuming UI — new fields land here rather
  -- than as new columns.
  payload JSONB NOT NULL DEFAULT '{}',
  -- NULL while unread; set by the UI when the admin dismisses / views.
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;

-- Org members can read their org's notifications.
CREATE POLICY "Org members can read their org notifications"
  ON notifications FOR SELECT USING (
    org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );

-- Org admins can update read_at on their own notifications (to mark read).
CREATE POLICY "Org admins can mark notifications read"
  ON notifications FOR UPDATE USING (
    org_id IN (
      SELECT org_id FROM org_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

-- Inserts are service-role only (worker-originated or future API routes).

CREATE INDEX idx_notifications_org_unread
  ON notifications (org_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX idx_notifications_org_recent
  ON notifications (org_id, created_at DESC);

NOTIFY pgrst, 'reload schema';
