-- Fix search_public_credentials RPC: column 'title' doesn't exist in anchors table.
-- Uses filename + metadata + description + credential_type for search.
-- Also searches SUBMITTED status (not just SECURED) and adds metadata text search.
--
-- ROLLBACK: DROP FUNCTION IF EXISTS search_public_credentials(text, integer);
-- Then re-create with the old definition (but the old one is broken, so this is a fix-only migration).

CREATE OR REPLACE FUNCTION search_public_credentials(p_query text, p_limit integer DEFAULT 10)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer;
  v_pattern text;
BEGIN
  v_limit := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
  v_pattern := '%' || p_query || '%';

  RETURN QUERY
  SELECT jsonb_build_object(
    'public_id', a.public_id,
    'title', a.filename,
    'credential_type', a.credential_type,
    'status', a.status,
    'created_at', a.created_at,
    'org_id', a.org_id
  )
  FROM anchors a
  WHERE a.status IN ('SECURED', 'SUBMITTED')
    AND a.deleted_at IS NULL
    AND (
      a.filename ILIKE v_pattern
      OR a.credential_type::text ILIKE v_pattern
      OR a.metadata::text ILIKE v_pattern
      OR a.description ILIKE v_pattern
    )
  ORDER BY a.created_at DESC
  LIMIT v_limit;
END;
$$;
