-- Migration 0081: RPC function for fetching unembedded public records
-- Fixes embedder bug: client-side anti-join via PostgREST breaks at scale
-- (URL length limits + fetching all IDs to client is O(n) waste)
--
-- ROLLBACK: DROP FUNCTION IF EXISTS get_unembedded_public_records(int);

CREATE OR REPLACE FUNCTION get_unembedded_public_records(p_limit int DEFAULT 100)
RETURNS TABLE (
  id uuid,
  title text,
  source text,
  record_type text,
  metadata jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pr.id, pr.title, pr.source, pr.record_type, pr.metadata
  FROM public_records pr
  LEFT JOIN public_record_embeddings pre ON pre.public_record_id = pr.id
  WHERE pre.id IS NULL
  ORDER BY pr.created_at ASC
  LIMIT p_limit;
$$;

-- Grant execute to service_role (worker uses service_role key)
GRANT EXECUTE ON FUNCTION get_unembedded_public_records(int) TO service_role;
