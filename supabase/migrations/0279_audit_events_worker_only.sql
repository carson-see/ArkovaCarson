-- Migration: 0276_audit_events_worker_only.sql
-- Description: SCRUM-1270 (R2-7) — make audit_events worker-only-write so the
--   trail is not forgeable by the actor it records (CLAUDE.md §1.4 immutability).
--   Migration 0011 created `audit_events_insert_own` allowing any authenticated
--   user to insert with `actor_id = auth.uid()`. That made the audit log
--   forgeable. Browser callers (src/lib/auditLog.ts, src/hooks/useIdleTimeout.ts)
--   now POST to /api/audit/event in the worker, which validates + inserts as
--   service_role. service_role is unaffected by RLS and keeps INSERT.
-- Rollback:
--   CREATE POLICY audit_events_insert_own ON audit_events
--     FOR INSERT TO authenticated
--     WITH CHECK (actor_id IS NULL OR actor_id = auth.uid());
--   GRANT INSERT ON audit_events TO authenticated;

DROP POLICY IF EXISTS audit_events_insert_own ON audit_events;
DROP POLICY IF EXISTS audit_events_insert_system ON audit_events;

-- Belt-and-suspenders: REVOKE the table-level INSERT privilege so a future
-- policy mistake can't accidentally re-enable forgery from anon/authenticated.
-- service_role bypasses RLS and is unaffected.
REVOKE INSERT ON audit_events FROM authenticated;
REVOKE INSERT ON audit_events FROM anon;

COMMENT ON TABLE audit_events IS
  'Append-only audit trail. Worker-only write path via service_role per SCRUM-1270 / CLAUDE.md §1.4. Browser callers POST /api/audit/event.';
