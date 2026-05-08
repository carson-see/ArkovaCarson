-- =============================================================================
-- Migration 0073: Guard credential_type immutability after PENDING
-- Finding: TLA-01 (from TLA+ model checking of bitcoinAnchor.machine.ts)
-- Date: 2026-03-20
--
-- PURPOSE
-- -------
-- The metadata column is protected by prevent_metadata_edit_after_secured()
-- (migration 0030), and description is guarded after SUBMITTED/SECURED
-- (migration 0068b). However, credential_type has no equivalent guard.
-- A user could theoretically change the credential type of a SECURED anchor.
--
-- This violates the immutability principle proven in the TLA+ model:
-- once an anchor leaves PENDING, its core identity fields are locked.
--
-- CHANGES
-- -------
-- 1. Add credential_type guard to protect_anchor_status_transition() trigger
--    Blocks changes when status is SUBMITTED, SECURED, or REVOKED.
-- =============================================================================

-- Update the trigger function to also protect credential_type
CREATE OR REPLACE FUNCTION protect_anchor_status_transition()
RETURNS TRIGGER AS $$
DECLARE
  jwt_role text;
BEGIN
  -- Get the current role from JWT claims
  jwt_role := current_setting('request.jwt.claims', true)::json->>'role';

  -- Service role can do anything
  IF jwt_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Users cannot change user_id
  IF OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'Cannot change anchor owner'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Users cannot set status to SECURED or SUBMITTED directly (only system can)
  IF OLD.status != 'SECURED' AND NEW.status = 'SECURED' THEN
    RAISE EXCEPTION 'Cannot set status to SECURED directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.status != 'SUBMITTED' AND NEW.status = 'SUBMITTED' THEN
    RAISE EXCEPTION 'Cannot set status to SUBMITTED directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Users cannot modify chain data
  IF OLD.chain_tx_id IS DISTINCT FROM NEW.chain_tx_id
     OR OLD.chain_block_height IS DISTINCT FROM NEW.chain_block_height
     OR OLD.chain_timestamp IS DISTINCT FROM NEW.chain_timestamp
     OR OLD.chain_confirmations IS DISTINCT FROM NEW.chain_confirmations THEN
    RAISE EXCEPTION 'Cannot modify chain data directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Users cannot modify revocation chain data
  IF OLD.revocation_tx_id IS DISTINCT FROM NEW.revocation_tx_id
     OR OLD.revocation_block_height IS DISTINCT FROM NEW.revocation_block_height THEN
    RAISE EXCEPTION 'Cannot modify revocation chain data directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Users cannot modify legal_hold
  IF OLD.legal_hold IS DISTINCT FROM NEW.legal_hold THEN
    RAISE EXCEPTION 'Cannot modify legal_hold directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Users cannot modify lineage fields (set by trigger on INSERT only)
  IF OLD.parent_anchor_id IS DISTINCT FROM NEW.parent_anchor_id THEN
    RAISE EXCEPTION 'Cannot modify parent_anchor_id directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.version_number IS DISTINCT FROM NEW.version_number THEN
    RAISE EXCEPTION 'Cannot modify version_number directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Description is immutable after SECURED or SUBMITTED
  IF (OLD.status IN ('SECURED', 'SUBMITTED', 'REVOKED'))
     AND OLD.description IS DISTINCT FROM NEW.description THEN
    RAISE EXCEPTION 'Cannot modify description after anchor is secured'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- TLA-01: credential_type is immutable after PENDING
  -- Once an anchor is SUBMITTED, SECURED, or REVOKED, its credential_type cannot change.
  IF (OLD.status IN ('SUBMITTED', 'SECURED', 'REVOKED'))
     AND OLD.credential_type IS DISTINCT FROM NEW.credential_type THEN
    RAISE EXCEPTION 'Cannot modify credential_type after anchor leaves PENDING'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- ROLLBACK
-- =============================================================================
-- Restore protect_anchor_status_transition() from 0068b (without credential_type guard)
