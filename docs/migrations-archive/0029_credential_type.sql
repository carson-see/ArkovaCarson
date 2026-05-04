-- =============================================================================
-- Migration 0029: Add credential_type column to anchors
-- Story: P4-TS-04 — Credential type classification
-- Date: 2026-03-09
--
-- PURPOSE
-- -------
-- Adds a credential_type enum and column to the anchors table so that
-- each anchor can be classified (DEGREE, LICENSE, CERTIFICATE, etc.).
-- This enables filtering, search, and display grouping in the registry.
--
-- CHANGES
-- -------
-- 1. Create credential_type enum
-- 2. Add credential_type column to anchors (nullable — existing records default NULL)
-- 3. Add index for credential_type filtering
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. Create credential_type enum
-- ---------------------------------------------------------------------------
CREATE TYPE credential_type AS ENUM (
  'DEGREE',
  'LICENSE',
  'CERTIFICATE',
  'TRANSCRIPT',
  'PROFESSIONAL',
  'OTHER'
);

COMMENT ON TYPE credential_type IS 'Classification of anchored credential documents';


-- ---------------------------------------------------------------------------
-- 2. Add credential_type column to anchors
-- ---------------------------------------------------------------------------
ALTER TABLE anchors ADD COLUMN IF NOT EXISTS credential_type credential_type;

COMMENT ON COLUMN anchors.credential_type IS 'Type of credential (DEGREE, LICENSE, CERTIFICATE, TRANSCRIPT, PROFESSIONAL, OTHER). NULL for legacy records.';


-- ---------------------------------------------------------------------------
-- 3. Index for filtering by credential type
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_anchors_credential_type
  ON anchors(credential_type)
  WHERE credential_type IS NOT NULL;


-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- ALTER TABLE anchors DROP COLUMN IF EXISTS credential_type;
-- DROP INDEX IF EXISTS idx_anchors_credential_type;
-- DROP TYPE IF EXISTS credential_type;
