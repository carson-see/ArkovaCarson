-- Migration: 0006_audit_events.sql
-- Description: Create append-only audit_events table
-- Rollback: DROP TABLE IF EXISTS audit_events; DROP FUNCTION IF EXISTS reject_audit_modification();

-- Function to reject UPDATE and DELETE on audit_events
CREATE OR REPLACE FUNCTION reject_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit events are immutable. % operations are not allowed.', TG_OP
    USING ERRCODE = 'check_violation';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Audit events table (append-only)
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Event metadata
  event_type text NOT NULL,
  event_category text NOT NULL,

  -- Actor (who performed the action)
  actor_id uuid NULL REFERENCES profiles(id) ON DELETE SET NULL,
  actor_email text NULL,
  actor_ip inet NULL,
  actor_user_agent text NULL,

  -- Target (what was affected)
  target_type text NULL,
  target_id uuid NULL,

  -- Organization context (for tenant scoping)
  org_id uuid NULL REFERENCES organizations(id) ON DELETE SET NULL,

  -- Event details (structured as text, not JSON)
  details text NULL,

  -- Timestamp (immutable)
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Constraints
  CONSTRAINT audit_events_event_type_length CHECK (char_length(event_type) >= 1 AND char_length(event_type) <= 100),
  CONSTRAINT audit_events_event_category_valid CHECK (
    event_category IN ('AUTH', 'ANCHOR', 'PROFILE', 'ORG', 'ADMIN', 'SYSTEM')
  ),
  CONSTRAINT audit_events_target_type_length CHECK (target_type IS NULL OR char_length(target_type) <= 50),
  CONSTRAINT audit_events_details_length CHECK (details IS NULL OR char_length(details) <= 10000)
);

-- Indexes for query performance
CREATE INDEX idx_audit_events_actor_id ON audit_events(actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX idx_audit_events_org_id ON audit_events(org_id) WHERE org_id IS NOT NULL;
CREATE INDEX idx_audit_events_event_type ON audit_events(event_type);
CREATE INDEX idx_audit_events_event_category ON audit_events(event_category);
CREATE INDEX idx_audit_events_created_at ON audit_events(created_at);
CREATE INDEX idx_audit_events_target ON audit_events(target_type, target_id) WHERE target_id IS NOT NULL;

-- Triggers to make table append-only (reject UPDATE and DELETE)
CREATE TRIGGER reject_audit_update
  BEFORE UPDATE ON audit_events
  FOR EACH ROW
  EXECUTE FUNCTION reject_audit_modification();

CREATE TRIGGER reject_audit_delete
  BEFORE DELETE ON audit_events
  FOR EACH ROW
  EXECUTE FUNCTION reject_audit_modification();

-- Comments
COMMENT ON TABLE audit_events IS 'Append-only audit log. UPDATE and DELETE are blocked by triggers.';
COMMENT ON COLUMN audit_events.event_type IS 'Specific event type (e.g., anchor.created, profile.updated)';
COMMENT ON COLUMN audit_events.event_category IS 'Event category: AUTH, ANCHOR, PROFILE, ORG, ADMIN, SYSTEM';
COMMENT ON COLUMN audit_events.actor_id IS 'User who performed the action (NULL for system events)';
COMMENT ON COLUMN audit_events.target_type IS 'Type of affected entity (e.g., anchor, profile)';
COMMENT ON COLUMN audit_events.target_id IS 'ID of affected entity';
