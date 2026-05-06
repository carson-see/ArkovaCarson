-- Migration: 0155_update_public_org_profile_rpc.sql
-- Description: Recreate get_public_org_profile to include twitter_url and industry_tag.
-- ROLLBACK: Re-run the previous version of get_public_org_profile (without twitter_url, industry_tag).

CREATE OR REPLACE FUNCTION get_public_org_profile(p_org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  -- Counts
  SELECT count(*), count(*) FILTER (WHERE status = 'SECURED')
  INTO total_count, secured_count
  FROM anchors
  WHERE org_id = p_org_id AND deleted_at IS NULL;

  -- Credential type breakdown
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'type', credential_type,
    'count', cnt
  ) ORDER BY cnt DESC), '[]'::jsonb)
  INTO breakdown
  FROM (
    SELECT credential_type, count(*) AS cnt
    FROM anchors
    WHERE org_id = p_org_id AND deleted_at IS NULL
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
