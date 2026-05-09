-- =============================================================================
-- Migration 0032: Fix lineage FK action + protect lineage fields from UPDATE
-- Story: Code review fixes for PR #3
-- Date: 2026-03-09
--
-- PURPOSE
-- -------
-- 1. Fix: The CHECK constraint anchors_lineage_root_is_v1 requires
--    (parent_anchor_id IS NOT NULL OR version_number = 1), but the FK
--    uses ON DELETE SET NULL. Deleting a parent would null parent_anchor_id
--    on v2+ children, violating the constraint. Fix: change to ON DELETE
--    RESTRICT. Anchors use soft delete (deleted_at), so hard deletes are
--    admin-only and should explicitly handle lineage first.
--
-- 2. Fix: parent_anchor_id and version_number have no UPDATE protection.
--    The existing protect_anchor_status_transition() trigger doesn't
--    guard these columns, so users can reparent records or set arbitrary
--    version numbers. Fix: add guards for both fields.
--
-- CHANGES
-- -------
-- 1. Drop and recreate parent_anchor_id FK with ON DELETE RESTRICT
-- 2. Update protect_anchor_status_transition() to guard lineage fields
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. Change FK from ON DELETE SET NULL to ON DELETE RESTRICT
-- ---------------------------------------------------------------------------
-- Drop the existing FK constraint (auto-named by Postgres)
ALTER TABLE anchors
  DROP CONSTRAINT IF EXISTS anchors_parent_anchor_id_fkey;

-- Recreate with ON DELETE RESTRICT
ALTER TABLE anchors
  ADD CONSTRAINT anchors_parent_anchor_id_fkey
  FOREIGN KEY (parent_anchor_id) REFERENCES anchors(id) ON DELETE RESTRICT;


-- ---------------------------------------------------------------------------
-- 2. Protect lineage fields from client-side UPDATE
-- ---------------------------------------------------------------------------
-- Recreate the trigger function with lineage guards added.
-- All existing guards (user_id, status, chain data, legal_hold) remain.

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

  -- Users cannot set status to SECURED directly (only system can)
  IF OLD.status != 'SECURED' AND NEW.status = 'SECURED' THEN
    RAISE EXCEPTION 'Cannot set status to SECURED directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Users cannot modify chain data
  IF OLD.chain_tx_id IS DISTINCT FROM NEW.chain_tx_id
     OR OLD.chain_block_height IS DISTINCT FROM NEW.chain_block_height
     OR OLD.chain_timestamp IS DISTINCT FROM NEW.chain_timestamp THEN
    RAISE EXCEPTION 'Cannot modify chain data directly'
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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- No need to recreate trigger — protect_anchor_fields trigger already
-- references this function and will pick up the new definition.


-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- Restore FK to ON DELETE SET NULL:
-- ALTER TABLE anchors DROP CONSTRAINT IF EXISTS anchors_parent_anchor_id_fkey;
-- ALTER TABLE anchors ADD CONSTRAINT anchors_parent_anchor_id_fkey
--   FOREIGN KEY (parent_anchor_id) REFERENCES anchors(id) ON DELETE SET NULL;
--
-- Restore protect_anchor_status_transition() WITHOUT lineage guards:
-- (see 0010_rls_anchors.sql for the original version)
