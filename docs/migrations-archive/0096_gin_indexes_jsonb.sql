-- =============================================================================
-- Migration 0096: Add GIN indexes on JSONB metadata columns
-- Story: DB-AUDIT SEC-4 — JSONB columns lack GIN indexes
-- Date: 2026-03-23
--
-- PURPOSE
-- -------
-- Multiple tables use JSONB columns (anchors.metadata, entitlements.value,
-- billing_events.payload, ai_usage_events) for flexible data. Queries filtering
-- on JSONB fields (e.g., metadata->pipeline_source) perform sequential scans.
--
-- Fix: Add GIN indexes using jsonb_path_ops for efficient JSONB containment
-- queries (@>) on frequently queried columns.
--
-- CHANGES
-- -------
-- 1. GIN index on anchors.metadata (most queried — pipeline_source, recipient)
-- 2. GIN index on entitlements.value (quota lookups)
-- 3. GIN index on ai_usage_events metadata (provider, model queries)
-- =============================================================================

-- 1. Anchors metadata — used for pipeline_source filtering, recipient lookups
CREATE INDEX IF NOT EXISTS idx_anchors_metadata_gin
  ON anchors USING GIN (metadata jsonb_path_ops);

-- 2. Entitlements value — used for quota type lookups
CREATE INDEX IF NOT EXISTS idx_entitlements_value_gin
  ON entitlements USING GIN (value jsonb_path_ops);

-- 3. AI usage events — SKIPPED: ai_usage_events has no metadata JSONB column.
--    Table uses discrete columns (provider, event_type, etc.) per migration 0059.
--    Original index target was incorrect.

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- DROP INDEX IF EXISTS idx_anchors_metadata_gin;
-- DROP INDEX IF EXISTS idx_entitlements_value_gin;
-- DROP INDEX IF EXISTS idx_ai_usage_events_metadata_gin;
