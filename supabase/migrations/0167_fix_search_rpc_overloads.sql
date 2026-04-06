-- Migration: 0167_fix_search_rpc_overloads.sql
-- Description: Fix PGRST203 "Could not choose the best candidate function"
--   error on search_public_issuers and search_public_credentials.
--
-- Problem: Both functions had multiple overloaded signatures in production
--   (one without p_offset, one with p_offset). PostgREST cannot disambiguate
--   between them when called from the client, returning HTTP 300.
--   This broke the public search page ("Search failed" on all tabs).
--
-- Fix: Drop the overloaded versions (with p_offset) and recreate
--   search_public_issuers with a p_limit parameter for consistency.
--
-- Task: SCRUM-455 — Public search broken
-- Depends on: 0157 (search_public_credentials), 0055 (search_public_issuers)
--
-- ROLLBACK:
--   -- No rollback needed; the dropped overloads are not used by any code path.

-- 1. Drop ALL versions of search_public_issuers and recreate with p_limit
DROP FUNCTION IF EXISTS search_public_issuers(text);
DROP FUNCTION IF EXISTS search_public_issuers(text, integer, integer);

CREATE OR REPLACE FUNCTION public.search_public_issuers(p_query text, p_limit integer DEFAULT 20)
 RETURNS TABLE(org_id uuid, org_name text, org_domain text, credential_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    o.id AS org_id,
    o.display_name AS org_name,
    o.domain AS org_domain,
    (
      SELECT COUNT(*)
      FROM anchors a
      WHERE a.org_id = o.id
        AND a.status = 'SECURED'
        AND a.deleted_at IS NULL
    ) AS credential_count
  FROM organizations o
  WHERE
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.org_id = o.id
        AND p.is_public_profile = true
        AND p.role = 'ORG_ADMIN'
    )
    AND (
      o.display_name ILIKE '%' || p_query || '%'
      OR o.legal_name ILIKE '%' || p_query || '%'
    )
  ORDER BY credential_count DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
END;
$$;

GRANT EXECUTE ON FUNCTION search_public_issuers(text, integer) TO anon;
GRANT EXECUTE ON FUNCTION search_public_issuers(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION search_public_issuers(text, integer) TO service_role;

-- 2. Drop the overloaded search_public_credentials with (p_query, p_limit, p_offset)
DROP FUNCTION IF EXISTS search_public_credentials(text, integer, integer);

-- 3. Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
