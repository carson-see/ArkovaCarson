-- Migration 0055: Public Search RPCs (UF-02)
-- Adds search_public_issuers and get_public_issuer_registry for credential discovery.
-- ROLLBACK: DROP FUNCTION IF EXISTS search_public_issuers(text); DROP FUNCTION IF EXISTS get_public_issuer_registry(uuid, integer, integer);

-- =============================================================================
-- 1. GIN index on organizations.display_name for full-text search performance
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_organizations_display_name_trgm
  ON organizations USING gin (display_name gin_trgm_ops);

-- Enable pg_trgm extension if not already enabled (for trigram similarity search)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- =============================================================================
-- 2. search_public_issuers — find organizations by name where profile is public
-- Returns only orgs that have at least one admin with is_public_profile = true
-- =============================================================================

CREATE OR REPLACE FUNCTION search_public_issuers(p_query text)
RETURNS TABLE (
  org_id uuid,
  org_name text,
  org_domain text,
  credential_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
    -- Org has at least one admin with public profile
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.org_id = o.id
        AND p.is_public_profile = true
        AND p.role = 'ORG_ADMIN'
    )
    -- Match on display_name (case-insensitive, trigram similarity)
    AND (
      o.display_name ILIKE '%' || p_query || '%'
      OR o.legal_name ILIKE '%' || p_query || '%'
    )
  ORDER BY credential_count DESC
  LIMIT 20;
END;
$$;

-- =============================================================================
-- 3. get_public_issuer_registry — list an org's public SECURED anchors
-- Only returns data if the org has a public-profile admin
-- =============================================================================

CREATE OR REPLACE FUNCTION get_public_issuer_registry(
  p_org_id uuid,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org record;
  v_anchors jsonb;
  v_total bigint;
BEGIN
  -- Verify the org exists and has a public-profile admin
  SELECT o.id, o.display_name, o.domain
  INTO v_org
  FROM organizations o
  WHERE o.id = p_org_id
    AND EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.org_id = o.id
        AND p.is_public_profile = true
        AND p.role = 'ORG_ADMIN'
    );

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Issuer not found or profile is not public');
  END IF;

  -- Count total public anchors
  SELECT COUNT(*)
  INTO v_total
  FROM anchors a
  WHERE a.org_id = p_org_id
    AND a.status = 'SECURED'
    AND a.deleted_at IS NULL;

  -- Fetch paginated anchors
  SELECT COALESCE(jsonb_agg(row_to_json(r)::jsonb), '[]'::jsonb)
  INTO v_anchors
  FROM (
    SELECT
      a.public_id,
      a.credential_type,
      a.filename,
      a.issued_at,
      a.created_at,
      a.label
    FROM anchors a
    WHERE a.org_id = p_org_id
      AND a.status = 'SECURED'
      AND a.deleted_at IS NULL
    ORDER BY a.created_at DESC
    LIMIT p_limit
    OFFSET p_offset
  ) r;

  RETURN jsonb_build_object(
    'org_id', v_org.id,
    'org_name', v_org.display_name,
    'org_domain', v_org.domain,
    'total', v_total,
    'anchors', v_anchors
  );
END;
$$;
