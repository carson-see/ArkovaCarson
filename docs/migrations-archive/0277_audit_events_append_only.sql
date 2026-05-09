-- SCRUM-1270 (R2-7) — audit_events: drop browser INSERT path, append-only at the table level.
--
-- Forensic 7 — RLS + Security flagged that the audit log is forgeable by the actor
-- it records, breaking the SOC-2 immutability claim. Migration 0190 granted
-- INSERT to authenticated as long as actor_id = auth.uid(). That is exactly the
-- forgery vector. From this migration on:
--   * authenticated callers cannot INSERT directly — they MUST go through the
--     worker route POST /api/audit/event which inserts as service_role.
--   * UPDATE and DELETE are blocked for everyone except service_role via RLS.
--
-- Existing rows are preserved untouched. The previous "browser-origin" rows
-- created via the dropped policy remain in the table — Forensic 7 records that
-- the trust footnote on those rows pre-dates this fix.
--
-- ROLLBACK: re-create the authenticated INSERT policy from migration 0190
--   CREATE POLICY audit_events_insert ON audit_events
--     FOR INSERT TO authenticated
--     WITH CHECK (actor_id IS NULL OR actor_id = (SELECT auth.uid()));
--   …and drop policies + REVOKE statements added below.

BEGIN;

-- 1. Drop the browser-side INSERT policy (the forgery vector).
DROP POLICY IF EXISTS audit_events_insert ON audit_events;

-- 2. Append-only: deny UPDATE and DELETE for authenticated and anon roles.
--    service_role bypasses RLS so the worker still has the keys it needs for
--    legitimate retention sweeps.
DROP POLICY IF EXISTS audit_events_no_update ON audit_events;
CREATE POLICY audit_events_no_update ON audit_events
  FOR UPDATE TO authenticated, anon
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS audit_events_no_delete ON audit_events;
CREATE POLICY audit_events_no_delete ON audit_events
  FOR DELETE TO authenticated, anon
  USING (false);

-- 3. Belt-and-braces: revoke direct table grants from the same roles. RLS would
--    refuse the operation regardless, but a defense-in-depth REVOKE means a
--    future policy mistake cannot accidentally re-open the path.
REVOKE INSERT, UPDATE, DELETE ON TABLE audit_events FROM authenticated, anon;

COMMENT ON TABLE audit_events IS
  'Append-only audit log. Writes are service_role-only via POST /api/audit/event '
  '(SCRUM-1270, 2026-04-27). Browser-direct inserts disabled to satisfy SOC-2 '
  'CC7.2 immutability. Pre-2026-04-27 rows may have been browser-originated.';

COMMIT;
