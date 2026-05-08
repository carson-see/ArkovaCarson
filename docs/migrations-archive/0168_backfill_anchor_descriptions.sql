-- Migration 0167: Backfill anchor descriptions from public_records metadata
--
-- Pipeline anchors (OpenAlex, EDGAR, USPTO, etc.) were created without populating
-- the description column. The abstracts/descriptions exist in public_records.metadata
-- but were never copied to anchors.description.
--
-- This migration:
-- 1. Updates the immutability trigger to allow NULL->value transitions (backfill-safe)
-- 2. Backfills description from public_records (abstract when available, title otherwise)
--
-- Safe: only touches anchors where description IS NULL and a matching public_record exists.
-- For large datasets (1M+ OpenAlex records), run backfill in batches of 1000 via:
--   WITH batch AS (
--     SELECT a.id, LEFT(COALESCE(pr.metadata->>'abstract', pr.title), 500) as desc
--     FROM anchors a JOIN public_records pr ON pr.source_id = a.metadata->>'source_id'
--       AND pr.source = a.metadata->>'pipeline_source'
--     WHERE a.metadata->>'pipeline_source' IS NOT NULL AND a.description IS NULL
--     LIMIT 1000
--   ) UPDATE anchors SET description = batch.desc FROM batch WHERE anchors.id = batch.id;

-- ---------------------------------------------------------------------------
-- 1. Update trigger to allow NULL->value transitions for backfill
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
    -- Allow setting description for the first time (NULL -> value) for backfill
    IF OLD.description IS NULL AND NEW.description IS NOT NULL
       AND (OLD.metadata IS NOT DISTINCT FROM NEW.metadata)
    THEN
      RETURN NEW;
    END IF;

    IF OLD.metadata IS DISTINCT FROM NEW.metadata THEN
      RAISE EXCEPTION 'Cannot modify metadata after anchor has been secured. Current status: %', OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.description IS DISTINCT FROM NEW.description THEN
      RAISE EXCEPTION 'Cannot modify description after anchor has been secured. Current status: %', OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Backfill descriptions (small sources — run large sources in batches)
-- ---------------------------------------------------------------------------
-- Small sources use title as description
UPDATE anchors a
SET description = LEFT(pr.title, 500)
FROM public_records pr
WHERE a.metadata->>'pipeline_source' IN ('calbar', 'dapip', 'npi', 'finra', 'acnc', 'courtlistener')
  AND a.metadata->>'source_id' = pr.source_id
  AND a.metadata->>'pipeline_source' = pr.source
  AND a.description IS NULL
  AND pr.title IS NOT NULL;

-- ---------------------------------------------------------------------------
-- ROLLBACK:
-- UPDATE anchors SET description = NULL WHERE metadata->>'pipeline_source' IS NOT NULL;
-- Restore original trigger from 0071_anchor_description.sql (without NULL->value exception)
-- ---------------------------------------------------------------------------
