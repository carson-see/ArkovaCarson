\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;

CREATE SCHEMA auth;
CREATE SCHEMA private;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.role',true),'')
$$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE TABLE public.organizations(
  id uuid PRIMARY KEY,
  parent_org_id uuid REFERENCES public.organizations(id),
  parent_approval_status text
);
CREATE TABLE public.profiles(
  id uuid PRIMARY KEY,
  org_id uuid REFERENCES public.organizations(id),
  role text
);
CREATE TYPE public.org_member_role AS ENUM ('owner', 'admin', 'member', 'compliance_officer');
CREATE TABLE public.org_members(
  user_id uuid REFERENCES public.profiles(id),
  org_id uuid REFERENCES public.organizations(id),
  role public.org_member_role,
  PRIMARY KEY(user_id,org_id)
);
CREATE TABLE public.api_keys(
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  is_active boolean NOT NULL DEFAULT true,
  revoked_at timestamptz,
  expires_at timestamptz
);
CREATE TABLE public.anchors(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  org_id uuid REFERENCES public.organizations(id),
  fingerprint char(64) NOT NULL,
  filename text NOT NULL,
  metadata jsonb,
  deleted_at timestamptz,
  status text DEFAULT 'PENDING',
  public_id text DEFAULT ('REC-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16))),
  credential_type text,
  fingerprint_source text
);
CREATE UNIQUE INDEX anchors_user_fingerprint_active_unique
  ON public.anchors(user_id,fingerprint) WHERE deleted_at IS NULL;
CREATE TABLE public.org_integrations(
  id uuid PRIMARY KEY,
  org_id uuid REFERENCES public.organizations(id),
  provider text,
  revoked_at timestamptz
);
CREATE TABLE public.member_integrations(
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES public.profiles(id),
  org_id uuid REFERENCES public.organizations(id),
  provider text,
  revoked_at timestamptz
);
CREATE TABLE public.connector_artifact(
  id uuid PRIMARY KEY,
  org_id uuid REFERENCES public.organizations(id),
  source text,
  integration_id uuid,
  external_ref text,
  fingerprint_sha256 text,
  metadata jsonb,
  status text,
  anchor_id uuid,
  updated_at timestamptz
);

CREATE FUNCTION public.trigger_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
CREATE FUNCTION public.get_user_org_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT org_id FROM public.profiles WHERE id=auth.uid()
$$;
CREATE FUNCTION public.get_caller_role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT auth.role()
$$;
CREATE FUNCTION public.get_user_org_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT org_id FROM public.org_members WHERE user_id=auth.uid()
$$;
CREATE FUNCTION public.is_current_user_platform_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND role='PLATFORM_ADMIN')
$$;
CREATE FUNCTION public.is_org_admin_of(target_org_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS(SELECT 1 FROM public.org_members WHERE user_id=auth.uid() AND org_id=target_org_id AND role::text IN ('owner','admin','ORG_ADMIN'))
$$;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;
GRANT SELECT ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
CREATE POLICY profiles_select_own ON public.profiles FOR SELECT TO authenticated USING (id=auth.uid());
CREATE POLICY profiles_select_org ON public.profiles FOR SELECT TO authenticated USING (org_id=public.get_user_org_id());

ALTER TABLE public.anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anchors FORCE ROW LEVEL SECURITY;
GRANT SELECT,UPDATE ON public.anchors TO authenticated;
GRANT ALL ON public.anchors TO service_role;
CREATE POLICY anchors_select ON public.anchors FOR SELECT TO authenticated USING (
  user_id=auth.uid() OR public.is_org_admin_of(org_id)
);
CREATE POLICY anchors_update ON public.anchors FOR UPDATE TO authenticated
  USING (user_id=auth.uid() OR public.is_org_admin_of(org_id))
  WITH CHECK (user_id=auth.uid() OR public.is_org_admin_of(org_id));

INSERT INTO public.organizations(id,parent_org_id,parent_approval_status) VALUES
 ('aaaaaaaa-0000-4000-8000-000000000001',NULL,NULL),
 ('bbbbbbbb-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','APPROVED'),
 ('cccccccc-0000-4000-8000-000000000001',NULL,NULL);
INSERT INTO public.profiles(id,org_id,role) VALUES
 ('11111111-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','ORG_ADMIN'),
 ('22222222-0000-4000-8000-000000000002','bbbbbbbb-0000-4000-8000-000000000001','INDIVIDUAL'),
 ('33333333-0000-4000-8000-000000000003','bbbbbbbb-0000-4000-8000-000000000001','INDIVIDUAL');
INSERT INTO public.org_members(user_id,org_id,role) VALUES
 ('11111111-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','owner'),
 ('22222222-0000-4000-8000-000000000002','bbbbbbbb-0000-4000-8000-000000000001','member'),
 ('33333333-0000-4000-8000-000000000003','bbbbbbbb-0000-4000-8000-000000000001','member');
