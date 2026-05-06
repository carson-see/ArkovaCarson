-- =============================================================================
-- Migration 0172: Add service_role bypass to credential_type immutability trigger
-- Date: 2026-04-07
--
-- PURPOSE
-- -------
-- Migration 0089 created prevent_credential_type_change() which blocks ALL
-- credential_type changes on non-PENDING anchors, including service_role.
-- The worker needs service_role to correct credential_type during AI
-- re-extraction. This adds a JWT role check to bypass for service_role,
-- matching the pattern used in protect_anchor_status_transition() (0068b).
--
-- ROLLBACK: Restore the original function without service_role bypass
-- =============================================================================

CREATE OR REPLACE FUNCTION prevent_credential_type_change()
RETURNS TRIGGER AS $$
DECLARE
  jwt_role text;
BEGIN
  -- Service role bypasses immutability (worker AI re-extraction)
  jwt_role := current_setting('request.jwt.claims', true)::json->>'role';
  IF jwt_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Only block changes when status is not PENDING
  IF OLD.status != 'PENDING' AND OLD.credential_type IS DISTINCT FROM NEW.credential_type THEN
    RAISE EXCEPTION 'credential_type cannot be changed after anchor status leaves PENDING (current: %)', OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = public;
