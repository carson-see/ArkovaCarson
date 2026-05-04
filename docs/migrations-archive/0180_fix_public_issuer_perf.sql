-- Migration: 0180_fix_public_issuer_perf.sql
-- Description: Fix Public Issuer page timeout by excluding pipeline records
-- from get_public_org_profile and get_public_issuer_registry RPCs.
-- Pipeline records (metadata->>'pipeline_source' IS NOT NULL) are bulk-ingested
-- public records that should NOT appear in org credential counts or listings.
--
-- ROLLBACK: Re-run migration 0155 (get_public_org_profile) and 0055 (get_public_issuer_registry).

-- =============================================================================
-- 1. Fix get_public_org_profile: exclude pipeline records from counts
-- =============================================================================

CREATE OR REPLACE FUNCTION get_public_org_profile(p_org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '10s'
AS $$
DECLARE
  result jsonb;
  org_row record;
  total_count bigint;
  secured_count bigint;
  breakdown jsonb;
BEGIN
  -- Fetch org
  SELECT id, display_name, domain, description, org_type,
         website_url, linkedin_url, twitter_url, logo_url,
         location, founded_date, industry_tag, created_at
  INTO org_row
  FROM organizations
  WHERE id = p_org_id;

  IF org_row IS NULL THEN
    RETURN jsonb_build_object('error', 'Organization not found');
  END IF;

  -- Counts — exclude pipeline records and deleted records
  SELECT count(*), count(*) FILTER (WHERE status = 'SECURED')
  INTO total_count, secured_count
  FROM anchors
  WHERE org_id = p_org_id
    AND deleted_at IS NULL
    AND (metadata->>'pipeline_source') IS NULL;

  -- Credential type breakdown — exclude pipeline records
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'type', credential_type,
    'count', cnt
  ) ORDER BY cnt DESC), '[]'::jsonb)
  INTO breakdown
  FROM (
    SELECT credential_type, count(*) AS cnt
    FROM anchors
    WHERE org_id = p_org_id
      AND deleted_at IS NULL
      AND (metadata->>'pipeline_source') IS NULL
    GROUP BY credential_type
  ) sub;

  result := jsonb_build_object(
    'org_id', org_row.id,
    'display_name', org_row.display_name,
    'domain', org_row.domain,
    'description', org_row.description,
    'org_type', org_row.org_type,
    'website_url', org_row.website_url,
    'linkedin_url', org_row.linkedin_url,
    'twitter_url', org_row.twitter_url,
    'logo_url', org_row.logo_url,
    'location', org_row.location,
    'founded_date', org_row.founded_date,
    'industry_tag', org_row.industry_tag,
    'created_at', org_row.created_at,
    'total_credentials', total_count,
    'secured_credentials', secured_count,
    'credential_breakdown', breakdown
  );

  RETURN result;
END;
$$;

-- =============================================================================
-- 2. Fix get_public_issuer_registry: exclude pipeline records from listing
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
SET statement_timeout = '10s'
AS $$
DECLARE
  result jsonb;
  org_row record;
  total_count bigint;
  anchors_list jsonb;
  has_public_admin boolean;
BEGIN
  -- Check org exists
  SELECT id, display_name, domain, description, logo_url
  INTO org_row
  FROM organizations
  WHERE id = p_org_id;

  IF org_row IS NULL THEN
    RETURN jsonb_build_object('error', 'Issuer not found');
  END IF;

  -- Check if org has a public-profile admin
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE org_id = p_org_id
      AND role = 'ORG_ADMIN'
      AND is_public_profile = true
  ) INTO has_public_admin;

  IF NOT has_public_admin THEN
    RETURN jsonb_build_object('error', 'Issuer profile is not public');
  END IF;

  -- Count SECURED non-pipeline records
  SELECT count(*)
  INTO total_count
  FROM anchors
  WHERE org_id = p_org_id
    AND status = 'SECURED'
    AND deleted_at IS NULL
    AND (metadata->>'pipeline_source') IS NULL;

  -- Fetch paginated list of SECURED non-pipeline records
  SELECT coalesce(jsonb_agg(row_to_json(a)::jsonb ORDER BY a.created_at DESC), '[]'::jsonb)
  INTO anchors_list
  FROM (
    SELECT id, public_id, filename, fingerprint, credential_type,
           status, created_at, chain_timestamp, chain_tx_id
    FROM anchors
    WHERE org_id = p_org_id
      AND status = 'SECURED'
      AND deleted_at IS NULL
      AND (metadata->>'pipeline_source') IS NULL
    ORDER BY created_at DESC
    LIMIT p_limit OFFSET p_offset
  ) a;

  result := jsonb_build_object(
    'org', jsonb_build_object(
      'id', org_row.id,
      'display_name', org_row.display_name,
      'domain', org_row.domain,
      'description', org_row.description,
      'logo_url', org_row.logo_url
    ),
    'total', total_count,
    'anchors', anchors_list
  );

  RETURN result;
END;
$$;

-- Ensure grants
GRANT EXECUTE ON FUNCTION get_public_org_profile(uuid) TO anon;
GRANT EXECUTE ON FUNCTION get_public_org_profile(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_public_org_profile(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION get_public_issuer_registry(uuid, integer, integer) TO anon;
GRANT EXECUTE ON FUNCTION get_public_issuer_registry(uuid, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION get_public_issuer_registry(uuid, integer, integer) TO service_role;

NOTIFY pgrst, 'reload schema';
