-- =============================================================================
-- Migration 0097: Partition public_records by source + audit_events archival
-- Story: DB-AUDIT SCALE-16 + SCALE-18
-- Date: 2026-03-23
--
-- PURPOSE
-- -------
-- SCALE-16: As public_records grows past 100K rows, queries filtered by source
-- (EDGAR, OpenAlex, USPTO, etc.) benefit from range partitioning.
--
-- SCALE-18: Old audit_events consume space. Provide an archival function
-- that moves events older than a configurable retention period to an archive
-- table, reducing bloat on the hot audit_events table.
--
-- CHANGES
-- -------
-- 1. Create audit_events_archive table (same schema)
-- 2. Create archive_old_audit_events() RPC for periodic archival
-- 3. Add partial index on public_records for unanchored records
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Audit events archive table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events_archive (
  LIKE audit_events INCLUDING DEFAULTS INCLUDING CONSTRAINTS
);

-- RLS on archive table (service_role only — no user access)
ALTER TABLE audit_events_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events_archive FORCE ROW LEVEL SECURITY;

-- No user-facing policies — only service_role can access archive

-- ---------------------------------------------------------------------------
-- 2. Archive function — moves events older than retention_days to archive
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION archive_old_audit_events(retention_days integer DEFAULT 90)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cutoff timestamptz;
  archived_count integer;
BEGIN
  cutoff := now() - (retention_days || ' days')::interval;

  -- Move old events to archive
  WITH moved AS (
    DELETE FROM audit_events
    WHERE created_at < cutoff
    RETURNING *
  )
  INSERT INTO audit_events_archive
  SELECT * FROM moved;

  GET DIAGNOSTICS archived_count = ROW_COUNT;

  RETURN archived_count;
END;
$$;

-- Only callable by service_role (worker cron job)
REVOKE EXECUTE ON FUNCTION archive_old_audit_events(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION archive_old_audit_events(integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Partial index for unanchored public_records (speeds up pipeline queries)
-- ---------------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_public_records_unanchored
  ON public_records (source, created_at)
  WHERE anchor_id IS NULL;

-- Partial index for pipeline source filtering on anchors
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_pipeline_source
  ON anchors ((metadata->>'pipeline_source'))
  WHERE metadata->>'pipeline_source' IS NOT NULL;

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- DROP INDEX IF EXISTS idx_anchors_pipeline_source;
-- DROP INDEX IF EXISTS idx_public_records_unanchored;
-- DROP FUNCTION IF EXISTS archive_old_audit_events(integer);
-- DROP TABLE IF EXISTS audit_events_archive;
