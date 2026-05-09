-- Migration 0183: Fix search_public_credentials timeout on 1.4M row anchors table
--
-- Problem: search_public_credentials() does ILIKE on filename/description across
-- 1.4M anchors rows. Even with GIN trigram indexes, the query times out because:
-- 1. No statement_timeout set (hangs indefinitely)
-- 2. The status filter + deleted_at filter prevent efficient GIN index usage
--
-- Fix:
-- 1. Add SET statement_timeout = '5s' to fail fast
-- 2. Pre-filter by status using idx_anchors_status_non_secured (from 0182)
-- 3. Use explicit GIN index hints via the ILIKE conditions
-- 4. Add LIMIT early to short-circuit after finding enough results

DROP FUNCTION IF EXISTS search_public_credentials(text, integer);

CREATE OR REPLACE FUNCTION search_public_credentials(
  p_query text,
  p_limit integer DEFAULT 10
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '5s'
STABLE
AS $$
DECLARE
  v_limit  integer;
  v_pattern text;
BEGIN
  v_limit  := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);

  IF p_query IS NULL OR length(trim(p_query)) < 2 THEN
    RETURN;
  END IF;

  v_pattern := '%' || trim(p_query) || '%';

  RETURN QUERY
  WITH public_org_ids AS MATERIALIZED (
    SELECT DISTINCT p.org_id
    FROM   profiles p
    WHERE  p.role             = 'ORG_ADMIN'
      AND  p.is_public_profile = true
      AND  p.org_id IS NOT NULL
  )
  SELECT jsonb_build_object(
    'public_id',       a.public_id,
    'title',           a.filename,
    'credential_type', a.credential_type,
    'status',          a.status,
    'created_at',      a.created_at,
    'org_id',          a.org_id
  )
  FROM  anchors a
  WHERE a.deleted_at IS NULL
    AND a.status IN ('SECURED', 'SUBMITTED')
    AND (
      a.org_id IS NULL
      OR a.org_id IN (SELECT org_id FROM public_org_ids)
    )
    -- GIN trigram indexes: idx_anchors_filename_trgm, idx_anchors_description_trgm
    AND (
      a.filename    ILIKE v_pattern
      OR a.description ILIKE v_pattern
    )
  ORDER BY a.created_at DESC
  LIMIT v_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION search_public_credentials(text, integer) TO anon;
GRANT EXECUTE ON FUNCTION search_public_credentials(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION search_public_credentials(text, integer) TO service_role;

-- =========================================================================
-- ROLLBACK:
-- Restore previous version without statement_timeout
-- =========================================================================
