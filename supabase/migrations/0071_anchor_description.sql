-- Migration 0071: Add immutable description field to anchors (BETA-12)
--
-- Adds a text description column that is:
-- 1. Set at anchor creation time
-- 2. Immutable after anchor leaves PENDING status (extends existing trigger)
-- 3. Max 500 characters
-- 4. Displayed on public verification page and API response
--
-- @see BETA-12 — Immutable Description Field on Anchors

-- ---------------------------------------------------------------------------
-- 1. Add description column
-- ---------------------------------------------------------------------------
ALTER TABLE anchors ADD COLUMN IF NOT EXISTS description TEXT;

-- Constraint: max 500 characters
ALTER TABLE anchors ADD CONSTRAINT anchors_description_max_length
  CHECK (description IS NULL OR char_length(description) <= 500);

COMMENT ON COLUMN anchors.description IS 'Brief, immutable description of the credential. Set at creation, locked after PENDING.';

-- ---------------------------------------------------------------------------
-- 2. Extend prevent_metadata_edit_after_secured() to also protect description
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_metadata_edit_after_secured()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Allow if neither metadata nor description changed
  IF (OLD.metadata IS NOT DISTINCT FROM NEW.metadata)
     AND (OLD.description IS NOT DISTINCT FROM NEW.description)
  THEN
    RETURN NEW;
  END IF;

  -- Block changes when status is not PENDING
  IF OLD.status != 'PENDING' THEN
    -- Determine which field changed for a clear error message
    IF OLD.metadata IS DISTINCT FROM NEW.metadata THEN
      RAISE EXCEPTION 'Cannot modify metadata after anchor has been secured, revoked, or expired. Current status: %', OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.description IS DISTINCT FROM NEW.description THEN
      RAISE EXCEPTION 'Cannot modify description after anchor has been secured, revoked, or expired. Current status: %', OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION prevent_metadata_edit_after_secured IS 'Prevents metadata and description edits once an anchor leaves PENDING status (BETA-12)';

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- ALTER TABLE anchors DROP CONSTRAINT IF EXISTS anchors_description_max_length;
-- ALTER TABLE anchors DROP COLUMN IF EXISTS description;
-- -- Restore original trigger from 0030_metadata_jsonb.sql (metadata only)
