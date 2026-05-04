-- Migration 0090: RPC to count public records by source
-- Avoids PostgREST row limit when counting by source on Pipeline page
-- ROLLBACK: DROP FUNCTION IF EXISTS count_public_records_by_source();

CREATE OR REPLACE FUNCTION count_public_records_by_source()
RETURNS TABLE(source text, count bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT source, COUNT(*) as count
  FROM public_records
  GROUP BY source
  ORDER BY count DESC;
$$;

-- Grant to authenticated users (admin page checks isPlatformAdmin in app code)
GRANT EXECUTE ON FUNCTION count_public_records_by_source() TO authenticated;
