-- Minimal schema replaying the prod shapes migration 0429 touches.
-- Column definitions and helper bodies are copied from the baseline / live prod
-- definitions read this session, not invented.

DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $r$;

CREATE SCHEMA auth;

-- auth.uid() reads a GUC so the harness can impersonate a user.
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('test.uid', true), '')::uuid;
$$;

CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name text NOT NULL,
  display_name text NOT NULL,
  domain text,
  verification_status text NOT NULL DEFAULT 'UNVERIFIED',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  public_id text,
  description text,
  website_url text,
  logo_url text,
  banner_url text,
  founded_date date,
  org_type text,
  linkedin_url text,
  twitter_url text,
  location text,
  industry_tag text,
  parent_org_id uuid REFERENCES public.organizations(id),
  parent_approval_status text,
  verified_badge_granted_at timestamptz
);

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  org_id uuid REFERENCES public.organizations(id),
  full_name text,
  public_id text,
  avatar_url text,
  is_public_profile boolean DEFAULT false
);

-- REAL enum, matching prod. It was `text` here originally, and that divergence
-- hid a live defect for the whole first round of proofs: every sub-org RPC
-- compares `role IN ('owner','admin','ORG_ADMIN')`, and 'ORG_ADMIN' is not a
-- label of this type, so on the real schema the comparison raises 22P02 and the
-- function throws. Against a text column it silently passed. Keep this faithful.
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='org_member_role') THEN
    CREATE TYPE public.org_member_role AS ENUM ('owner','admin','member','compliance_officer');
  END IF;
END $r$;

CREATE TABLE public.org_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  role public.org_member_role NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.anchors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES public.organizations(id),
  status text NOT NULL DEFAULT 'PENDING',
  credential_type text,
  deleted_at timestamptz,
  metadata jsonb DEFAULT '{}'::jsonb
);

CREATE TABLE public.org_credits (
  org_id uuid PRIMARY KEY REFERENCES public.organizations(id),
  balance integer NOT NULL DEFAULT 0,
  monthly_allocation integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Helpers (bodies as read from the baseline this session) ──────────────────

CREATE FUNCTION public.get_caller_role() RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE role_val text;
BEGIN
  role_val := current_setting('request.jwt.claim.role', true);
  IF role_val IS NOT NULL AND role_val != '' THEN RETURN role_val; END IF;
  RETURN NULL;
END; $$;

CREATE FUNCTION public.is_org_admin_of(target_org_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = auth.uid()
      AND org_id = target_org_id
      AND role IN ('owner', 'admin')
  );
$$;

CREATE FUNCTION public.is_current_user_platform_admin() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT coalesce(nullif(current_setting('test.platform_admin', true), '')::boolean, false);
$$;

-- ── Pre-0429 function bodies (exactly as deployed in prod) ───────────────────

CREATE OR REPLACE FUNCTION public.get_public_org_profile(p_org_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public' SET statement_timeout TO '10s'
AS $function$
DECLARE
  result jsonb; org_row record; total_count bigint; secured_count bigint;
  breakdown jsonb; members jsonb; sub_orgs jsonb;
BEGIN
  SELECT id, public_id, display_name, domain, description, org_type,
         website_url, linkedin_url, twitter_url, logo_url,
         location, founded_date, industry_tag, verification_status, created_at
  INTO org_row FROM organizations WHERE id = p_org_id;
  IF org_row IS NULL THEN RETURN jsonb_build_object('error', 'Organization not found'); END IF;
  SELECT count(*), count(*) FILTER (WHERE status = 'SECURED')
  INTO total_count, secured_count FROM anchors
  WHERE org_id = p_org_id AND deleted_at IS NULL AND (metadata->>'pipeline_source') IS NULL;
  SELECT coalesce(jsonb_agg(jsonb_build_object('type', credential_type, 'count', cnt) ORDER BY cnt DESC), '[]'::jsonb)
  INTO breakdown FROM (
    SELECT credential_type, count(*) AS cnt FROM anchors
    WHERE org_id = p_org_id AND deleted_at IS NULL AND (metadata->>'pipeline_source') IS NULL
    GROUP BY credential_type) sub;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'profile_public_id', CASE WHEN coalesce(p.is_public_profile, false) THEN p.public_id ELSE NULL END,
    'display_name', CASE WHEN coalesce(p.is_public_profile, false) THEN coalesce(nullif(p.full_name, ''), 'Public member') ELSE 'Anonymous member' END,
    'avatar_url', CASE WHEN coalesce(p.is_public_profile, false) THEN p.avatar_url ELSE NULL END,
    'role', om.role, 'is_public_profile', coalesce(p.is_public_profile, false)
  ) ORDER BY CASE om.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END,
    CASE WHEN coalesce(p.is_public_profile, false) THEN coalesce(p.full_name, p.public_id) ELSE p.public_id END
  ), '[]'::jsonb) INTO members
  FROM org_members om JOIN profiles p ON p.id = om.user_id WHERE om.org_id = p_org_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'org_id', child.id, 'public_id', child.public_id, 'display_name', child.display_name,
    'domain', child.domain, 'description', child.description, 'logo_url', child.logo_url,
    'org_type', child.org_type, 'website_url', child.website_url,
    'verification_status', child.verification_status
  ) ORDER BY child.display_name), '[]'::jsonb) INTO sub_orgs
  FROM organizations child
  WHERE child.parent_org_id = p_org_id AND child.parent_approval_status = 'APPROVED';
  result := jsonb_build_object(
    'org_id', org_row.id, 'display_name', org_row.display_name,
    'total_credentials', total_count, 'secured_credentials', secured_count,
    'credential_breakdown', breakdown, 'public_members', members,
    'sub_organizations', sub_orgs);
  RETURN result;
END; $function$;

CREATE OR REPLACE FUNCTION public.get_org_subtree(p_root_id uuid, p_max_depth integer DEFAULT 3)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public' SET statement_timeout TO '5s'
AS $function$
DECLARE effective_depth integer := greatest(1, least(coalesce(p_max_depth, 3), 3)); result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = p_root_id) THEN
    RETURN jsonb_build_object('error', 'Organization not found'); END IF;
  WITH RECURSIVE tree AS (
    SELECT o.id, o.public_id, o.parent_org_id, o.parent_approval_status,
      o.display_name, o.domain, o.description, o.logo_url, o.banner_url,
      o.org_type, o.website_url, o.verification_status,
      o.verified_badge_granted_at, 1 AS depth
    FROM organizations o WHERE o.id = p_root_id
    UNION ALL
    SELECT o.id, o.public_id, o.parent_org_id, o.parent_approval_status,
      o.display_name, o.domain, o.description, o.logo_url, o.banner_url,
      o.org_type, o.website_url, o.verification_status,
      o.verified_badge_granted_at, t.depth + 1
    FROM organizations o JOIN tree t ON t.id = o.parent_org_id
    WHERE t.depth < effective_depth
      AND coalesce(o.parent_approval_status, 'APPROVED') = 'APPROVED')
  SELECT jsonb_build_object('root_id', p_root_id, 'max_depth', effective_depth,
    'nodes', coalesce(jsonb_agg(jsonb_build_object(
      'org_id', t.id, 'display_name', t.display_name, 'depth', t.depth
    ) ORDER BY t.depth, t.display_name), '[]'::jsonb)) INTO result FROM tree t;
  RETURN result;
END; $function$;
