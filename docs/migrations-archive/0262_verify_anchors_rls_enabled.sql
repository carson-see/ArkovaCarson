-- Migration 0262: Add verify_anchors_rls_enabled() RPC for the production smoke test
--
-- Problem: The /system-health "rls-active" smoke check was a copy-paste of the
-- "anchor-count" check — `db.from('anchors').select('*', { count: 'exact' })` —
-- which (a) hits the PostgREST 60s timeout on the 1.4M-row anchors table, and
-- (b) runs as service_role, which BYPASSES RLS entirely. So it was never
-- actually verifying RLS was enforced.
--
-- Fix: Provide a tiny SECURITY DEFINER function that reads pg_class to confirm
-- both ENABLE ROW LEVEL SECURITY and FORCE ROW LEVEL SECURITY are set on the
-- anchors table. CLAUDE.md §1.4 requires both. Returns boolean. Cheap (<1ms).
--
-- Tied to SCRUM-1235.

CREATE OR REPLACE FUNCTION verify_anchors_rls_enabled()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT COALESCE(
    (SELECT relrowsecurity AND relforcerowsecurity
       FROM pg_class
      WHERE relname = 'anchors'
        AND relnamespace = 'public'::regnamespace),
    false
  );
$$;

-- Smoke test caller is the worker (service_role), but grant authenticated too
-- so a future authenticated admin route can call this without escalating.
GRANT EXECUTE ON FUNCTION verify_anchors_rls_enabled() TO authenticated;
GRANT EXECUTE ON FUNCTION verify_anchors_rls_enabled() TO service_role;

COMMENT ON FUNCTION verify_anchors_rls_enabled() IS
  'SCRUM-1235: production smoke test "rls-active" check. Returns true iff anchors has both ENABLE and FORCE ROW LEVEL SECURITY set. Cheap pg_class lookup — does not touch row data.';

-- ROLLBACK:
-- DROP FUNCTION IF EXISTS verify_anchors_rls_enabled();
