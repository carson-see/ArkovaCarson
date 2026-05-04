-- Migration: Performance fixes for anchor stats queries
-- 1. Index on (credential_type, status) for get_anchor_type_counts
-- 2. Fix get_anchor_type_counts to filter deleted_at and add timeout
-- 3. New RPC get_anchor_status_counts for treasury dashboard (replaces 5 RLS-limited queries)
-- ROLLBACK: DROP INDEX IF EXISTS idx_anchors_credential_type_status; DROP FUNCTION IF EXISTS get_anchor_status_counts();

-- 1. Composite index for type+status grouping
CREATE INDEX IF NOT EXISTS idx_anchors_credential_type_status
ON anchors (credential_type, status) WHERE deleted_at IS NULL;

-- 2. Fix get_anchor_type_counts: add deleted_at filter + statement timeout
CREATE OR REPLACE FUNCTION get_anchor_type_counts()
RETURNS TABLE(credential_type text, status text, count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '10s'
AS $$
  SELECT
    COALESCE(a.credential_type::text, 'UNKNOWN') AS credential_type,
    a.status::text AS status,
    count(*) AS count
  FROM anchors a
  WHERE a.deleted_at IS NULL
  GROUP BY a.credential_type, a.status
  ORDER BY count(*) DESC;
$$;

GRANT EXECUTE ON FUNCTION get_anchor_type_counts() TO authenticated;
GRANT EXECUTE ON FUNCTION get_anchor_type_counts() TO service_role;

-- 3. New RPC for anchor status counts (SECURITY DEFINER — bypasses RLS)
CREATE OR REPLACE FUNCTION get_anchor_status_counts()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '10s'
AS $$
  SELECT json_object_agg(status, cnt)
  FROM (
    SELECT status::text, count(*) AS cnt
    FROM anchors
    WHERE deleted_at IS NULL
    GROUP BY status
  ) sub;
$$;

GRANT EXECUTE ON FUNCTION get_anchor_status_counts() TO authenticated;
GRANT EXECUTE ON FUNCTION get_anchor_status_counts() TO service_role;
