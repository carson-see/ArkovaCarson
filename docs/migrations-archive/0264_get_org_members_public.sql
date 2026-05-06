-- Migration: 0264_get_org_members_public.sql
-- SCRUM-1086 PUBLIC-ORG-03 — Member anonymization resolver (server-side function).
-- Description: Dedicated paginated/standalone resolver for org public members.
--   Splits member-list logic out of `get_public_org_profile` (migration 0245)
--   so consumers can fetch members independently (paginated, lighter payload)
--   while still respecting the same anonymization contract.
--
-- Anonymization contract (must match get_public_org_profile):
--   - When `profiles.is_public_profile = true`:
--       display_name := coalesce(nullif(p.full_name, ''), 'Public member')
--       avatar_url   := p.avatar_url
--       profile_public_id := p.public_id
--   - When `profiles.is_public_profile = false` (or NULL):
--       display_name := initial-from-full_name + last-name (e.g. "A. Smith"),
--                        falling back to 'Anonymous member' if full_name unparseable
--       avatar_url   := NULL
--       profile_public_id := NULL  ← never leak user_id-equivalent
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS get_org_members_public(uuid, integer, integer);

-- Build an "A. Smith"-style anonymized display name from a full name.
-- Null/empty/single-token names fall back to 'Anonymous member' so we never
-- emit something that looks like real PII.
CREATE OR REPLACE FUNCTION anonymize_member_display_name(p_full_name text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  parts text[];
  initial text;
  last_name text;
BEGIN
  IF p_full_name IS NULL OR length(trim(p_full_name)) = 0 THEN
    RETURN 'Anonymous member';
  END IF;
  parts := regexp_split_to_array(trim(p_full_name), '\s+');
  IF array_length(parts, 1) < 2 THEN
    RETURN 'Anonymous member';
  END IF;
  initial := upper(left(parts[1], 1));
  last_name := parts[array_length(parts, 1)];
  RETURN initial || '. ' || last_name;
END;
$$;

CREATE OR REPLACE FUNCTION get_org_members_public(
  p_org_id uuid,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '5s'
STABLE
AS $$
DECLARE
  result jsonb;
  total_count bigint;
  members jsonb;
  effective_limit integer;
  effective_offset integer;
BEGIN
  -- Defensive: clamp paging args so a hostile caller can't trigger a huge scan.
  effective_limit := greatest(1, least(coalesce(p_limit, 50), 200));
  effective_offset := greatest(0, coalesce(p_offset, 0));

  -- Existence + visibility check: only resolve members for orgs that exist.
  -- (No additional gating here — `get_public_org_profile` already trusts the
  -- caller; matching that contract keeps the surface consistent.)
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = p_org_id) THEN
    RETURN jsonb_build_object('error', 'Organization not found');
  END IF;

  SELECT count(*)
  INTO total_count
  FROM org_members
  WHERE org_id = p_org_id;

  SELECT coalesce(jsonb_agg(member ORDER BY ord_role, ord_name), '[]'::jsonb)
  INTO members
  FROM (
    SELECT
      jsonb_build_object(
        'profile_public_id',
          CASE WHEN coalesce(p.is_public_profile, false) THEN p.public_id ELSE NULL END,
        'display_name',
          CASE
            WHEN coalesce(p.is_public_profile, false)
              THEN coalesce(nullif(p.full_name, ''), 'Public member')
            ELSE anonymize_member_display_name(p.full_name)
          END,
        'avatar_url',
          CASE WHEN coalesce(p.is_public_profile, false) THEN p.avatar_url ELSE NULL END,
        'role', om.role,
        'is_public_profile', coalesce(p.is_public_profile, false)
      ) AS member,
      CASE om.role
        WHEN 'owner' THEN 1
        WHEN 'admin' THEN 2
        ELSE 3
      END AS ord_role,
      CASE
        WHEN coalesce(p.is_public_profile, false)
          THEN coalesce(p.full_name, p.public_id)
        ELSE p.public_id
      END AS ord_name
    FROM org_members om
    JOIN profiles p ON p.id = om.user_id
    WHERE om.org_id = p_org_id
    ORDER BY ord_role, ord_name
    LIMIT effective_limit
    OFFSET effective_offset
  ) sub;

  result := jsonb_build_object(
    'org_id', p_org_id,
    'total', total_count,
    'limit', effective_limit,
    'offset', effective_offset,
    'members', members
  );
  RETURN result;
END;
$$;

-- The public org endpoint must be reachable by anon visitors (issuer pages
-- are publicly indexable); members payload is already anonymized for non-
-- public-profile users.
GRANT EXECUTE ON FUNCTION get_org_members_public(uuid, integer, integer) TO anon;
GRANT EXECUTE ON FUNCTION get_org_members_public(uuid, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION get_org_members_public(uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION anonymize_member_display_name(text) TO anon;
GRANT EXECUTE ON FUNCTION anonymize_member_display_name(text) TO authenticated;
GRANT EXECUTE ON FUNCTION anonymize_member_display_name(text) TO service_role;

NOTIFY pgrst, 'reload schema';
