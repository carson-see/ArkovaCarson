-- =============================================================================
-- Migration 0030: Add metadata JSONB column + editability trigger
-- Story: P4-TS-05 — Structured metadata for anchors
-- Date: 2026-03-09
--
-- PURPOSE
-- -------
-- Adds a metadata JSONB column to anchors for storing structured
-- credential metadata (issuer, recipient, custom fields).
-- An editability trigger prevents metadata changes once the anchor
-- is SECURED, REVOKED, or EXPIRED — metadata is only editable while PENDING.
--
-- CHANGES
-- -------
-- 1. Add metadata JSONB column to anchors
-- 2. Add constraint: metadata must be a JSON object (not array/scalar)
-- 3. Create trigger: block metadata edits when status != PENDING
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. Add metadata JSONB column
-- ---------------------------------------------------------------------------
ALTER TABLE anchors ADD COLUMN IF NOT EXISTS metadata jsonb;

COMMENT ON COLUMN anchors.metadata IS 'Structured credential metadata (issuer, recipient, custom fields). Only editable while status = PENDING.';


-- ---------------------------------------------------------------------------
-- 2. Constraint: metadata must be a JSON object if provided
-- ---------------------------------------------------------------------------
ALTER TABLE anchors ADD CONSTRAINT anchors_metadata_is_object
  CHECK (metadata IS NULL OR jsonb_typeof(metadata) = 'object');


-- ---------------------------------------------------------------------------
-- 3. Trigger: block metadata edits when status != PENDING
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_metadata_edit_after_secured()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Allow if metadata hasn't changed
  IF OLD.metadata IS NOT DISTINCT FROM NEW.metadata THEN
    RETURN NEW;
  END IF;

  -- Block metadata changes when status is not PENDING
  IF OLD.status != 'PENDING' THEN
    RAISE EXCEPTION 'Cannot modify metadata after anchor has been secured, revoked, or expired. Current status: %', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER prevent_metadata_edit_trigger
  BEFORE UPDATE ON anchors
  FOR EACH ROW
  EXECUTE FUNCTION prevent_metadata_edit_after_secured();

COMMENT ON FUNCTION prevent_metadata_edit_after_secured IS 'Prevents metadata edits once an anchor leaves PENDING status';


-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- DROP TRIGGER IF EXISTS prevent_metadata_edit_trigger ON anchors;
-- DROP FUNCTION IF EXISTS prevent_metadata_edit_after_secured();
-- ALTER TABLE anchors DROP CONSTRAINT IF EXISTS anchors_metadata_is_object;
-- ALTER TABLE anchors DROP COLUMN IF EXISTS metadata;
