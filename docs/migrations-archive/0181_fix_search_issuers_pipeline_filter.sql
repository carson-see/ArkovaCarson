-- Migration: 0181_fix_search_issuers_pipeline_filter.sql
-- Fix: BUG-S33-01 — search_public_issuers credential_count includes pipeline records
--
-- The LEFT JOIN on anchors counted all SECURED anchors including bulk pipeline-ingested
-- records (1.4M+), inflating the credential count. This mirrors the fix applied in
-- migration 0180 for get_public_org_profile and get_public_issuer_registry.
--
-- Also drops stale 2-arg overload from migration 0177 that causes ambiguous function errors.
-- Uses profiles.is_public_profile instead of organizations.is_public (which doesn't exist
-- in production schema) to match get_public_issuer_registry's approach.
-- Uses correlated subquery for credential_count to leverage idx_anchors_org_nopipeline_created.
--
-- ROLLBACK: Re-run migration 0179 definition (without pipeline filter)
--           + re-create 2-arg overload from 0177

-- Drop the stale 2-arg overload (p_query text, p_limit integer) from migration 0177
DROP FUNCTION IF EXISTS search_public_issuers(text, integer);

CREATE OR REPLACE FUNCTION search_public_issuers(
  p_query text,
  p_limit int DEFAULT 20,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  legal_name text,
  display_name text,
  public_id text,
  verified boolean,
  credential_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '10s'
STABLE
AS $$
DECLARE
  v_safe_query text;
  v_pattern text;
BEGIN
  -- Escape ILIKE wildcards to prevent enumeration
  v_safe_query := replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_');
  v_pattern := '%' || v_safe_query || '%';

  RETURN QUERY
  SELECT
    o.id,
    o.legal_name,
    o.display_name,
    o.public_id,
    o.verification_status = 'APPROVED' AS verified,
    (
      SELECT count(*)
      FROM anchors a
      WHERE a.org_id = o.id
        AND a.status = 'SECURED'
        AND a.deleted_at IS NULL
        AND (a.metadata->>'pipeline_source') IS NULL
    ) AS credential_count
  FROM organizations o
  WHERE EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.org_id = o.id
      AND p.role = 'ORG_ADMIN'
      AND p.is_public_profile = true
  )
  AND (
    o.legal_name ILIKE v_pattern
    OR o.display_name ILIKE v_pattern
  )
  ORDER BY credential_count DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

NOTIFY pgrst, 'reload schema';
