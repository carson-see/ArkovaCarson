-- =============================================================================
-- Migration 0037: Move public_id generation from UPDATE to INSERT
-- Story: P5-TS-05
-- Date: 2026-03-09
--
-- PURPOSE
-- -------
-- The anchor public_id is currently generated only when status transitions
-- to SECURED (BEFORE UPDATE trigger). This means PENDING anchors have no
-- public_id, which prevents early URL generation and credential issuance
-- workflows. Moving generation to INSERT ensures every anchor gets a
-- public_id immediately upon creation.
--
-- CHANGES
-- -------
-- 1. Replace auto_generate_public_id() to fire on INSERT (unconditionally)
-- 2. Drop the old UPDATE trigger, create a new INSERT trigger
-- 3. Backfill existing anchors that have NULL public_id
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. Replace auto_generate_public_id() — now fires on INSERT
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auto_generate_public_id()
RETURNS TRIGGER AS $$
BEGIN
  -- Always generate public_id on INSERT if not already set
  IF NEW.public_id IS NULL THEN
    NEW.public_id := generate_public_id();

    -- Ensure uniqueness (retry if collision)
    WHILE EXISTS (SELECT 1 FROM anchors WHERE public_id = NEW.public_id AND id != NEW.id) LOOP
      NEW.public_id := generate_public_id();
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ---------------------------------------------------------------------------
-- 2. Drop old UPDATE trigger, create new INSERT trigger
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS generate_public_id_on_secured ON anchors;

CREATE TRIGGER generate_public_id_on_insert
  BEFORE INSERT ON anchors
  FOR EACH ROW
  EXECUTE FUNCTION auto_generate_public_id();


-- ---------------------------------------------------------------------------
-- 3. Backfill: generate public_id for existing anchors that lack one
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  anchor_row RECORD;
  new_pid text;
BEGIN
  FOR anchor_row IN
    SELECT id FROM anchors WHERE public_id IS NULL
  LOOP
    new_pid := generate_public_id();
    WHILE EXISTS (SELECT 1 FROM anchors WHERE public_id = new_pid) LOOP
      new_pid := generate_public_id();
    END LOOP;

    UPDATE anchors SET public_id = new_pid WHERE id = anchor_row.id;
  END LOOP;
END;
$$;


-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- Restore UPDATE trigger from 0020_public_verification.sql:
--
-- CREATE OR REPLACE FUNCTION auto_generate_public_id()
-- RETURNS TRIGGER AS $$
-- BEGIN
--   IF NEW.status = 'SECURED' AND OLD.status != 'SECURED' AND NEW.public_id IS NULL THEN
--     NEW.public_id := generate_public_id();
--     WHILE EXISTS (SELECT 1 FROM anchors WHERE public_id = NEW.public_id AND id != NEW.id) LOOP
--       NEW.public_id := generate_public_id();
--     END LOOP;
--   END IF;
--   RETURN NEW;
-- END;
-- $$ LANGUAGE plpgsql;
--
-- DROP TRIGGER IF EXISTS generate_public_id_on_insert ON anchors;
-- CREATE TRIGGER generate_public_id_on_secured
--   BEFORE UPDATE ON anchors
--   FOR EACH ROW
--   EXECUTE FUNCTION auto_generate_public_id();
