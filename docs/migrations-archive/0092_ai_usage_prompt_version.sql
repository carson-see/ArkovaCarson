-- Migration 0092: Add prompt_version to ai_usage_events
--
-- Stores the hash of the extraction prompt used for each AI call.
-- Enables tracking which prompt version produced which results,
-- essential for A/B testing prompt changes and detecting drift.
--
-- ROLLBACK: ALTER TABLE ai_usage_events DROP COLUMN IF EXISTS prompt_version;

ALTER TABLE ai_usage_events
  ADD COLUMN IF NOT EXISTS prompt_version TEXT;

COMMENT ON COLUMN ai_usage_events.prompt_version IS 'SHA-256 hash prefix (12 chars) of the extraction prompt used';
