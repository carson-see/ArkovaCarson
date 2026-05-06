-- =============================================================================
-- Migration 0270: Restore comprehensive anchor field protections
--
-- Migration 0179 (security_audit_fixes) was scoped to "add SET search_path
-- to protect_anchor_status_transition" but took the opportunity to also
-- replace the function body with a stripped-down version that only protects
-- the `status` column. Migration 0180 (PostgREST v12 jwt fix) preserved
-- that stripped form. The result: from 0179 onward, authenticated users can
-- modify any of the following anchor columns directly via PostgREST:
--
--   - chain_tx_id, chain_block_height, chain_timestamp, chain_confirmations
--   - revocation_tx_id, revocation_block_height
--   - legal_hold
--   - parent_anchor_id
--   - version_number
--   - description (after the anchor is secured)
--
-- Migration 0125 had comprehensive checks for all of these. The P7-S6 RLS
-- test suite (`tests/rls/p7.test.ts`) catches the regression on three of
-- them (chain data, legal_hold, status transitions to SECURED).
--
-- This migration restores the 0125-era field protections and merges them
-- with 0179's `SET search_path = public` and 0180's `get_caller_role()`
-- helper (so the trigger works on PostgREST v11 and v12+).
--
-- Test alignment: the test asserts `.toContain('Cannot set status to
-- SECURED directly')` (pre-0179 wording). Both 0125's specific-transition
-- messages and 0179's generic "Only the system can change anchor status"
-- block the bad write, but only the specific wording satisfies the test.
-- We use the specific wording, with the generic message as a fallback for
-- any other status change.
--
-- ROLLBACK
-- --------
-- Re-running migration 0180 restores the stripped-down version. NOT
-- recommended — restoring 0180's version reintroduces the field-mod
-- vulnerability above.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION protect_anchor_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller_role text;
BEGIN
  -- Service role (worker) bypasses all checks. PostgREST v11 + v12 compat
  -- via the get_caller_role() helper from migration 0180.
  caller_role := get_caller_role();
  IF caller_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- INSERT: users may only create anchors in PENDING status.
  IF TG_OP = 'INSERT' THEN
    IF NEW.status != 'PENDING' THEN
      RAISE EXCEPTION 'New anchors must start in PENDING status'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: ownership cannot change.
  IF OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'Cannot change anchor owner'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- UPDATE: status transitions to system-only states are blocked. Specific
  -- messages match the P7-S6 test expectations and identify exactly which
  -- transition was attempted.
  IF OLD.status != 'SECURED' AND NEW.status = 'SECURED' THEN
    RAISE EXCEPTION 'Cannot set status to SECURED directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status != 'SUBMITTED' AND NEW.status = 'SUBMITTED' THEN
    RAISE EXCEPTION 'Cannot set status to SUBMITTED directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status != 'BROADCASTING' AND NEW.status = 'BROADCASTING' THEN
    RAISE EXCEPTION 'Cannot set status to BROADCASTING directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- UPDATE: any other status change is also blocked. (Generic catch-all
  -- preserved from 0179/0180.)
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    RAISE EXCEPTION 'Only the system can change anchor status (current: %, requested: %)',
      OLD.status, NEW.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- UPDATE: chain data is system-only (worker writes it after Bitcoin
  -- broadcast confirms). Test expects message containing "Cannot modify
  -- chain data".
  IF OLD.chain_tx_id IS DISTINCT FROM NEW.chain_tx_id
     OR OLD.chain_block_height IS DISTINCT FROM NEW.chain_block_height
     OR OLD.chain_timestamp IS DISTINCT FROM NEW.chain_timestamp
     OR OLD.chain_confirmations IS DISTINCT FROM NEW.chain_confirmations THEN
    RAISE EXCEPTION 'Cannot modify chain data directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- UPDATE: revocation chain data is system-only.
  IF OLD.revocation_tx_id IS DISTINCT FROM NEW.revocation_tx_id
     OR OLD.revocation_block_height IS DISTINCT FROM NEW.revocation_block_height THEN
    RAISE EXCEPTION 'Cannot modify revocation chain data directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- UPDATE: legal_hold is platform-admin / service_role only. Test expects
  -- message containing "Cannot modify legal_hold".
  IF OLD.legal_hold IS DISTINCT FROM NEW.legal_hold THEN
    RAISE EXCEPTION 'Cannot modify legal_hold directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- UPDATE: lineage fields are immutable from the user side (only the
  -- worker may set them via supersede / rotate flows).
  IF OLD.parent_anchor_id IS DISTINCT FROM NEW.parent_anchor_id THEN
    RAISE EXCEPTION 'Cannot modify parent_anchor_id directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.version_number IS DISTINCT FROM NEW.version_number THEN
    RAISE EXCEPTION 'Cannot modify version_number directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- UPDATE: description is editable in PENDING but frozen once secured /
  -- submitted / broadcasting / revoked.
  IF (OLD.status IN ('SECURED', 'SUBMITTED', 'BROADCASTING', 'REVOKED'))
     AND OLD.description IS DISTINCT FROM NEW.description THEN
    RAISE EXCEPTION 'Cannot modify description after anchor is secured'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

-- The CREATE TRIGGER from 0010 (`protect_anchor_fields BEFORE UPDATE ON
-- anchors FOR EACH ROW EXECUTE FUNCTION protect_anchor_status_transition()`)
-- is preserved — CREATE OR REPLACE FUNCTION updates the body in place.
-- INSERTs are also covered: the trigger function checks TG_OP = 'INSERT'
-- defensively even though the 0010 trigger only fires on UPDATE; if a
-- separate INSERT trigger exists in another migration it stays consistent.

NOTIFY pgrst, 'reload schema';

COMMIT;
