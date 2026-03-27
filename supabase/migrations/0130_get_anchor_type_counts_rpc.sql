-- Migration: 0130_get_anchor_type_counts_rpc.sql
-- Purpose: RPC function for PipelineAdminPage credential type breakdown
-- Returns anchor counts grouped by credential_type and status
-- ROLLBACK: DROP FUNCTION IF EXISTS get_anchor_type_counts();

CREATE OR REPLACE FUNCTION get_anchor_type_counts()
RETURNS TABLE(credential_type text, status text, count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(a.credential_type::text, 'UNKNOWN') AS credential_type,
    a.status::text AS status,
    count(*) AS count
  FROM anchors a
  GROUP BY a.credential_type, a.status
  ORDER BY count(*) DESC;
$$;

-- Grant to authenticated (admin check is in the frontend, RLS covers row access)
GRANT EXECUTE ON FUNCTION get_anchor_type_counts() TO authenticated;
GRANT EXECUTE ON FUNCTION get_anchor_type_counts() TO service_role;
