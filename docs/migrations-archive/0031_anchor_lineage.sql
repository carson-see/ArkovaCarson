-- =============================================================================
-- Migration 0031: Add parent_anchor_id + version_number lineage columns
-- Story: P4-TS-06 — Credential versioning and lineage tracking
-- Date: 2026-03-09
--
-- PURPOSE
-- -------
-- Adds self-referencing parent_anchor_id and version_number columns
-- to support credential versioning (e.g., updated diplomas, renewed licenses).
-- The first version in a lineage is version 1. Each subsequent version
-- references its parent and increments the version number.
--
-- CHANGES
-- -------
-- 1. Add parent_anchor_id (self-referencing FK) and version_number columns
-- 2. Add constraints for lineage integrity
-- 3. Add index for lineage lookups
-- 4. Create trigger: auto-set version_number on INSERT
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. Add lineage columns
-- ---------------------------------------------------------------------------

-- Self-referencing FK: points to the previous version of this credential
ALTER TABLE anchors ADD COLUMN IF NOT EXISTS parent_anchor_id uuid
  REFERENCES anchors(id) ON DELETE SET NULL;

-- Version number within a lineage (1 = original, 2+ = updates)
ALTER TABLE anchors ADD COLUMN IF NOT EXISTS version_number integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN anchors.parent_anchor_id IS 'Previous version of this credential (NULL for originals). Self-referencing FK.';
COMMENT ON COLUMN anchors.version_number IS 'Version number in lineage chain (1 = original, 2+ = updates).';


-- ---------------------------------------------------------------------------
-- 2. Constraints
-- ---------------------------------------------------------------------------

-- Version number must be positive
ALTER TABLE anchors ADD CONSTRAINT anchors_version_positive
  CHECK (version_number >= 1);

-- If parent_anchor_id is NULL, version must be 1 (originals are always v1)
ALTER TABLE anchors ADD CONSTRAINT anchors_lineage_root_is_v1
  CHECK (parent_anchor_id IS NOT NULL OR version_number = 1);

-- Cannot be your own parent
ALTER TABLE anchors ADD CONSTRAINT anchors_no_self_reference
  CHECK (parent_anchor_id IS NULL OR parent_anchor_id != id);


-- ---------------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------------

-- Look up all versions of a credential by parent
CREATE INDEX IF NOT EXISTS idx_anchors_parent_anchor_id
  ON anchors(parent_anchor_id)
  WHERE parent_anchor_id IS NOT NULL;


-- ---------------------------------------------------------------------------
-- 4. Trigger: auto-set version_number on INSERT
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_anchor_version_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- If no parent, this is an original — version 1
  IF NEW.parent_anchor_id IS NULL THEN
    NEW.version_number := 1;
    RETURN NEW;
  END IF;

  -- Set version to parent's version + 1
  SELECT version_number + 1 INTO NEW.version_number
  FROM anchors
  WHERE id = NEW.parent_anchor_id;

  -- If parent not found (shouldn't happen due to FK), default to 1
  IF NEW.version_number IS NULL THEN
    NEW.version_number := 1;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER set_anchor_version_trigger
  BEFORE INSERT ON anchors
  FOR EACH ROW
  EXECUTE FUNCTION set_anchor_version_number();

COMMENT ON FUNCTION set_anchor_version_number IS 'Auto-computes version_number from parent lineage on anchor insert';


-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- DROP TRIGGER IF EXISTS set_anchor_version_trigger ON anchors;
-- DROP FUNCTION IF EXISTS set_anchor_version_number();
-- ALTER TABLE anchors DROP CONSTRAINT IF EXISTS anchors_no_self_reference;
-- ALTER TABLE anchors DROP CONSTRAINT IF EXISTS anchors_lineage_root_is_v1;
-- ALTER TABLE anchors DROP CONSTRAINT IF EXISTS anchors_version_positive;
-- ALTER TABLE anchors DROP COLUMN IF EXISTS version_number;
-- ALTER TABLE anchors DROP COLUMN IF EXISTS parent_anchor_id;
