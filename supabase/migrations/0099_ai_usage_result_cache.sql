-- Migration 0099: Add result_json column to ai_usage_events for extraction caching (EFF-1)
--
-- Enables returning cached extraction results for duplicate fingerprints,
-- saving ~30% of AI token costs from re-uploads and shared documents.
--
-- ROLLBACK: ALTER TABLE ai_usage_events DROP COLUMN IF EXISTS result_json;

ALTER TABLE ai_usage_events
  ADD COLUMN IF NOT EXISTS result_json jsonb DEFAULT NULL;

-- Index for cache lookups: fingerprint + event_type + success + result_json IS NOT NULL
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_cache_lookup
  ON ai_usage_events (fingerprint, event_type, success)
  WHERE result_json IS NOT NULL;

COMMENT ON COLUMN ai_usage_events.result_json IS 'Cached extraction result fields for EFF-1 cache-by-fingerprint optimization';
