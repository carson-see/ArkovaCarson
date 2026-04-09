-- Migration 0184: Add trigram indexes for search performance
-- Fixes: search_public_credentials ILIKE '%query%' timeout on 1.4M+ row anchors table
-- Bug: Searching "Arkova" returns 500 (statement_timeout 5s exceeded)
-- Fix: GIN trigram indexes enable ILIKE to use index scan instead of sequential scan

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_filename_trgm
  ON anchors USING gin (filename gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_description_trgm
  ON anchors USING gin (description gin_trgm_ops)
  WHERE deleted_at IS NULL;

-- ROLLBACK:
-- DROP INDEX IF EXISTS idx_anchors_filename_trgm;
-- DROP INDEX IF EXISTS idx_anchors_description_trgm;
