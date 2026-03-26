-- =============================================================================
-- Migration 0122: Change audit_events.target_id from uuid to text
-- Date: 2026-03-26
--
-- PURPOSE
-- -------
-- The bulk_create_anchors function (0093) inserts a text identifier like
-- 'bulk_create_20260326_143015' into target_id, but the column is typed uuid.
-- This causes: "column target_id is of type uuid but expression is of type text".
--
-- Changing to text is safe because:
-- - All existing values are UUIDs (valid as text)
-- - Frontend auditLog.ts already passes string values
-- - Some operations (batch, pipeline) need non-UUID identifiers
--
-- CHANGES
-- -------
-- 1. Alter audit_events.target_id from uuid to text
-- 2. Alter audit_events_archive.target_id from uuid to text (if exists)
-- =============================================================================

ALTER TABLE audit_events ALTER COLUMN target_id TYPE text USING target_id::text;

-- Also fix the archive table if it exists
ALTER TABLE IF EXISTS audit_events_archive ALTER COLUMN target_id TYPE text USING target_id::text;

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- ALTER TABLE audit_events ALTER COLUMN target_id TYPE uuid USING target_id::uuid;
-- ALTER TABLE IF EXISTS audit_events_archive ALTER COLUMN target_id TYPE uuid USING target_id::uuid;
