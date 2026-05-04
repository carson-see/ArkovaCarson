-- Migration: 0011_rls_audit_events.sql
-- Description: RLS policies for audit_events table
-- Rollback: DROP POLICY IF EXISTS audit_events_select_own ON audit_events; DROP POLICY IF EXISTS audit_events_insert_system ON audit_events;

-- =============================================================================
-- SELECT POLICY: Users can only read their own audit events
-- =============================================================================

CREATE POLICY audit_events_select_own ON audit_events
  FOR SELECT
  TO authenticated
  USING (actor_id = auth.uid());

-- =============================================================================
-- INSERT POLICY: Allow authenticated users to create audit events
-- =============================================================================

-- Note: In production, audit event creation might be restricted to
-- server-side functions. For P1, we allow authenticated inserts
-- with actor_id constraint.

CREATE POLICY audit_events_insert_own ON audit_events
  FOR INSERT
  TO authenticated
  WITH CHECK (
    -- Actor must be the current user (or NULL for system events)
    actor_id IS NULL OR actor_id = auth.uid()
  );

-- =============================================================================
-- UPDATE POLICY: No updates allowed
-- =============================================================================

-- No UPDATE policy needed - the reject_audit_modification trigger
-- prevents all updates at the database level

-- =============================================================================
-- DELETE POLICY: No deletes allowed
-- =============================================================================

-- No DELETE policy needed - the reject_audit_modification trigger
-- prevents all deletes at the database level

-- Comments
COMMENT ON POLICY audit_events_select_own ON audit_events IS 'Users can only read audit events where they are the actor';
COMMENT ON POLICY audit_events_insert_own ON audit_events IS 'Users can insert audit events for their own actions';
