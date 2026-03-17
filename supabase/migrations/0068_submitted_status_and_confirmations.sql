-- =============================================================================
-- Migration 0068: Add SUBMITTED status + chain_confirmations column
-- Story: BETA-01 (Mempool Live Transaction Tracking)
-- Date: 2026-03-17
--
-- PURPOSE
-- -------
-- Support a two-phase anchor lifecycle: PENDING → SUBMITTED → SECURED.
-- After broadcasting a fingerprint to Bitcoin, the anchor enters SUBMITTED
-- state (tx in mempool). A confirmation checker job promotes it to SECURED
-- once the tx is mined into a block.
--
-- Also adds chain_confirmations to track how deep in the blockchain the
-- anchor's transaction is, and revocation chain fields for BETA-02.
--
-- CHANGES
-- -------
-- 1. Add SUBMITTED to anchor_status enum
-- 2. Add chain_confirmations column to anchors
-- 3. Add revocation_tx_id and revocation_block_height columns (BETA-02)
-- 4. Add description column (BETA-12)
-- 5. Update protect_anchor_status_transition() to allow new transitions
-- =============================================================================

-- 1. Add SUBMITTED to anchor_status enum
ALTER TYPE anchor_status ADD VALUE IF NOT EXISTS 'SUBMITTED';

-- 2. Add chain_confirmations column
ALTER TABLE anchors
  ADD COLUMN IF NOT EXISTS chain_confirmations INTEGER DEFAULT 0;

COMMENT ON COLUMN anchors.chain_confirmations IS 'Number of blockchain confirmations for this anchor transaction';

-- 3. Add revocation chain fields (BETA-02)
ALTER TABLE anchors
  ADD COLUMN IF NOT EXISTS revocation_tx_id TEXT,
  ADD COLUMN IF NOT EXISTS revocation_block_height INTEGER;

COMMENT ON COLUMN anchors.revocation_tx_id IS 'Network receipt ID for the revocation OP_RETURN transaction';
COMMENT ON COLUMN anchors.revocation_block_height IS 'Block height at which the revocation transaction was mined';

-- 4. Add description column (BETA-12)
ALTER TABLE anchors
  ADD COLUMN IF NOT EXISTS description TEXT;

COMMENT ON COLUMN anchors.description IS 'Immutable description of what this credential represents (set at creation, locked after SECURED)';

-- 5. Update status transition trigger to allow PENDING → SUBMITTED and SUBMITTED → SECURED
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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 6. Index for confirmation checker: find SUBMITTED anchors efficiently
CREATE INDEX IF NOT EXISTS idx_anchors_submitted_status
  ON anchors (status) WHERE status = 'SUBMITTED';

-- =============================================================================
-- ROLLBACK
-- =============================================================================
-- Note: Cannot remove enum values in Postgres. To rollback:
-- ALTER TABLE anchors DROP COLUMN IF EXISTS chain_confirmations;
-- ALTER TABLE anchors DROP COLUMN IF EXISTS revocation_tx_id;
-- ALTER TABLE anchors DROP COLUMN IF EXISTS revocation_block_height;
-- ALTER TABLE anchors DROP COLUMN IF EXISTS description;
-- DROP INDEX IF EXISTS idx_anchors_submitted_status;
-- Restore protect_anchor_status_transition() from 0032_fix_lineage_constraints.sql
