-- Migration: 0150_fix_search_performance_indexes.sql
-- Description: Add trigram GIN indexes on anchors table for search_public_credentials
--   RPC. The ILIKE queries on filename, description, and credential_type cause full
--   table scans on 1.39M+ rows, resulting in statement timeouts (500 errors).
-- ROLLBACK: DROP INDEX IF EXISTS idx_anchors_filename_trgm;
--           DROP INDEX IF EXISTS idx_anchors_description_trgm;
--           DROP INDEX IF EXISTS idx_anchors_credential_type_trgm;

-- BUG-001: search_public_credentials returns 500 due to full table scan
-- with ILIKE on 1.39M rows. Add trigram indexes for substring matching.

-- pg_trgm already enabled (0051, 0055, 0106)

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_filename_trgm
  ON anchors USING GIN (filename gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_description_trgm
  ON anchors USING GIN (description gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_credential_type_trgm
  ON anchors USING GIN ((credential_type::text) gin_trgm_ops);

-- Also add a partial index for the common status filter to help the planner
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_status_secured_submitted
  ON anchors (created_at DESC)
  WHERE status IN ('SECURED', 'SUBMITTED') AND deleted_at IS NULL;
