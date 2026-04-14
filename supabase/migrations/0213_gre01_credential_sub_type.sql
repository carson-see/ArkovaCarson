-- =============================================================================
-- Migration 0213: Add credential_sub_type column to anchors table
-- Story: GRE-01 — Define Sub-Type Taxonomy
-- Date: 2026-04-14
--
-- PURPOSE
-- -------
-- Gemini extraction currently classifies documents into 23 credential types.
-- Sub-types enable fine-grained distinction: "official undergraduate transcript"
-- vs "transfer evaluation", "nursing RN" vs "nursing NP", etc.
--
-- The sub_type column is nullable — existing records and records where Gemini
-- can't determine a sub-type will have NULL. This is additive and non-breaking.
--
-- CHANGES
-- -------
-- 1. Add sub_type TEXT column to anchors (nullable, no enum — sub-types evolve faster than types)
-- 2. Add index for filtering by sub_type
-- =============================================================================

ALTER TABLE anchors ADD COLUMN IF NOT EXISTS sub_type TEXT;

-- Partial index: only index rows that have a sub_type (most will be NULL initially)
CREATE INDEX IF NOT EXISTS idx_anchors_sub_type
  ON anchors (sub_type)
  WHERE sub_type IS NOT NULL;

COMMENT ON COLUMN anchors.sub_type IS 'GRE-01: Fine-grained credential sub-type (e.g., official_undergraduate, nursing_rn). Nullable — NULL means not yet classified or not applicable.';

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- DROP INDEX IF EXISTS idx_anchors_sub_type;
-- ALTER TABLE anchors DROP COLUMN IF EXISTS sub_type;
