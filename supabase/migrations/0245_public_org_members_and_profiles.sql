-- Migration: 0245_public_org_members_and_profiles.sql
-- Description: Complete public org profile payload with verified status,
-- public/anonymized members, approved sub-orgs, and safe public member profiles.
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS get_public_member_profile(text);
--   Re-run migration 0180 for the previous get_public_org_profile body.

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
  members jsonb;
  sub_orgs jsonb;
BEGIN
  SELECT id, public_id, display_name, domain, description, org_type,
         website_url, linkedin_url, twitter_url, logo_url,
         location, founded_date, industry_tag, verification_status, created_at
  INTO org_row
  FROM organizations
  WHERE id = p_org_id;

  IF org_row IS NULL THEN
    RETURN jsonb_build_object('error', 'Organization not found');
  END IF;

  SELECT count(*), count(*) FILTER (WHERE status = 'SECURED')
  INTO total_count, secured_count
  FROM anchors
  WHERE org_id = p_org_id
    AND deleted_at IS NULL
    AND (metadata->>'pipeline_source') IS NULL;

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

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'profile_public_id', CASE WHEN coalesce(p.is_public_profile, false) THEN p.public_id ELSE NULL END,
    'display_name', CASE
      WHEN coalesce(p.is_public_profile, false) THEN coalesce(nullif(p.full_name, ''), 'Public member')
      ELSE 'Anonymous member'
    END,
    'avatar_url', CASE WHEN coalesce(p.is_public_profile, false) THEN p.avatar_url ELSE NULL END,
    'role', om.role,
    'is_public_profile', coalesce(p.is_public_profile, false)
  ) ORDER BY
    CASE om.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END,
    CASE WHEN coalesce(p.is_public_profile, false) THEN coalesce(p.full_name, p.public_id) ELSE p.public_id END
  ), '[]'::jsonb)
  INTO members
  FROM org_members om
  JOIN profiles p ON p.id = om.user_id
  WHERE om.org_id = p_org_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'org_id', child.id,
    'public_id', child.public_id,
    'display_name', child.display_name,
    'domain', child.domain,
    'description', child.description,
    'logo_url', child.logo_url,
    'org_type', child.org_type,
    'website_url', child.website_url,
    'verification_status', child.verification_status
  ) ORDER BY child.display_name), '[]'::jsonb)
  INTO sub_orgs
  FROM organizations child
  WHERE child.parent_org_id = p_org_id
    AND child.parent_approval_status = 'APPROVED';

  result := jsonb_build_object(
    'org_id', org_row.id,
    'public_id', org_row.public_id,
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
    'verification_status', org_row.verification_status,
    'created_at', org_row.created_at,
    'total_credentials', total_count,
    'secured_credentials', secured_count,
    'credential_breakdown', breakdown,
    'public_members', members,
    'sub_organizations', sub_orgs
  );

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION get_public_member_profile(p_public_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '10s'
STABLE
AS $$
DECLARE
  profile_row record;
  orgs jsonb;
BEGIN
  SELECT id, public_id, full_name, avatar_url, bio, social_links, created_at
  INTO profile_row
  FROM profiles
  WHERE public_id = p_public_id
    AND is_public_profile = true;

  IF profile_row IS NULL THEN
    RETURN jsonb_build_object('error', 'Profile not found');
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'org_id', o.id,
    'public_id', o.public_id,
    'display_name', o.display_name,
    'domain', o.domain,
    'logo_url', o.logo_url,
    'verification_status', o.verification_status,
    'role', om.role
  ) ORDER BY o.display_name), '[]'::jsonb)
  INTO orgs
  FROM org_members om
  JOIN organizations o ON o.id = om.org_id
  WHERE om.user_id = profile_row.id;

  RETURN jsonb_build_object(
    'public_id', profile_row.public_id,
    'display_name', coalesce(nullif(profile_row.full_name, ''), 'Public member'),
    'avatar_url', profile_row.avatar_url,
    'bio', profile_row.bio,
    'social_links', profile_row.social_links,
    'created_at', profile_row.created_at,
    'organizations', orgs
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_public_org_profile(uuid) TO anon;
GRANT EXECUTE ON FUNCTION get_public_org_profile(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_public_org_profile(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION get_public_member_profile(text) TO anon;
GRANT EXECUTE ON FUNCTION get_public_member_profile(text) TO authenticated;
GRANT EXECUTE ON FUNCTION get_public_member_profile(text) TO service_role;

NOTIFY pgrst, 'reload schema';
