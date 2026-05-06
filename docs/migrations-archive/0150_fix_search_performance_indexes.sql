-- Migration: 0150_fix_search_performance_indexes.sql
-- Description: Add trigram GIN indexes on anchors table for search_public_credentials
--   RPC. The ILIKE queries on filename, description, and credential_type cause full
--   table scans on 1.39M+ rows, resulting in statement timeouts (500 errors).
-- ROLLBACK: DROP INDEX IF EXISTS idx_anchors_filename_trgm;
--           DROP INDEX IF EXISTS idx_anchors_description_trgm;
--           DROP INDEX IF EXISTS idx_anchors_credential_type_btree;
--           DROP INDEX IF EXISTS idx_anchors_status_secured_submitted;

-- BUG-001: search_public_credentials returns 500 due to full table scan
-- with ILIKE on 1.39M rows. Add trigram indexes for substring matching.

-- pg_trgm already enabled (0051, 0055, 0106)

CREATE INDEX IF NOT EXISTS idx_anchors_filename_trgm
  ON anchors USING GIN (filename gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_anchors_description_trgm
  ON anchors USING GIN (description gin_trgm_ops);

-- credential_type is a PostgreSQL enum — enum casts are not IMMUTABLE so
-- trigram GIN is not possible. A plain btree index on the enum covers
-- equality and ILIKE-to-equality rewrites the planner can apply.
CREATE INDEX IF NOT EXISTS idx_anchors_credential_type_btree
  ON anchors (credential_type);

-- Partial index for the common status filter to help the planner
CREATE INDEX IF NOT EXISTS idx_anchors_status_secured_submitted
  ON anchors (created_at DESC)
  WHERE status IN ('SECURED', 'SUBMITTED') AND deleted_at IS NULL;
