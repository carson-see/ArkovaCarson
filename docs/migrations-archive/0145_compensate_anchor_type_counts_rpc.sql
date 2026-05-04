-- Compensating migration for deleted 0130_get_anchor_type_counts_rpc.sql
-- (duplicate PK with 0130_batch_insert_anchors_rpc.sql)
-- CREATE OR REPLACE is inherently idempotent.
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

GRANT EXECUTE ON FUNCTION get_anchor_type_counts() TO authenticated;
GRANT EXECUTE ON FUNCTION get_anchor_type_counts() TO service_role;
