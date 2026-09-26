BEGIN;
SET LOCAL lock_timeout = '5s';

-- UAT-14: ownership-scoped profile/organization brand media.
-- The bucket is private. Public pages receive only opaque object paths from
-- narrow public RPCs and exchange them for short-lived signed URLs. Personal
-- paths cease to be signable as soon as is_public_profile is false.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS avatar_storage_path text,
  ADD COLUMN IF NOT EXISTS banner_storage_path text;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS logo_storage_path text,
  ADD COLUMN IF NOT EXISTS banner_storage_path text;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_avatar_storage_path_owner CHECK (avatar_storage_path IS NULL OR (public_id IS NOT NULL AND avatar_storage_path ~ ('^users/' || public_id || '/avatar/[0-9a-f-]{36}\.png$'))),
  ADD CONSTRAINT profiles_banner_storage_path_owner CHECK (banner_storage_path IS NULL OR (public_id IS NOT NULL AND banner_storage_path ~ ('^users/' || public_id || '/banner/[0-9a-f-]{36}\.png$')));
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_logo_storage_path_owner CHECK (logo_storage_path IS NULL OR (public_id IS NOT NULL AND logo_storage_path ~ ('^organizations/' || public_id || '/logo/[0-9a-f-]{36}\.png$'))),
  ADD CONSTRAINT organizations_banner_storage_path_owner CHECK (banner_storage_path IS NULL OR (public_id IS NOT NULL AND banner_storage_path ~ ('^organizations/' || public_id || '/banner/[0-9a-f-]{36}\.png$')));

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('profile-media', 'profile-media', false, 2097152,
        ARRAY['image/png'])
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE OR REPLACE FUNCTION public.can_read_profile_media(object_name text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN object_name ~ '^users/[A-Za-z0-9_-]{3,128}/(avatar|banner)/[0-9a-f-]{36}\.png$'
      THEN EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.public_id = split_part(object_name, '/', 2) AND p.deleted_at IS NULL
            AND ((p.id = auth.uid() AND p.status='ACTIVE' AND private.is_human_mfa_verified())
              OR (p.is_public_profile AND p.status='ACTIVE' AND object_name IN (p.avatar_storage_path, p.banner_storage_path)))
        )
    WHEN object_name ~ '^organizations/[A-Za-z0-9_-]{3,128}/(logo|banner)/[0-9a-f-]{36}\.png$'
      THEN EXISTS (
        SELECT 1 FROM public.organizations o
        WHERE o.public_id = split_part(object_name, '/', 2)
          AND NOT o.suspended
          AND (object_name IN (o.logo_storage_path, o.banner_storage_path) OR EXISTS (
            SELECT 1 FROM public.org_members om JOIN public.profiles actor ON actor.id=om.user_id
            WHERE om.org_id=o.id AND om.user_id=auth.uid() AND om.role IN ('owner','admin')
              AND actor.deleted_at IS NULL AND actor.status='ACTIVE' AND private.is_human_mfa_verified()
          ))
      )
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION public.can_write_profile_media(object_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT private.is_human_mfa_verified() AND EXISTS (
    SELECT 1 FROM public.profiles actor WHERE actor.id=auth.uid() AND actor.deleted_at IS NULL AND actor.status='ACTIVE'
  ) AND (
    (object_name ~ '^users/[A-Za-z0-9_-]{3,128}/(avatar|banner)/[0-9a-f-]{36}\.png$' AND EXISTS (
      SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.public_id=split_part(object_name,'/',2)
    )) OR
    (object_name ~ '^organizations/[A-Za-z0-9_-]{3,128}/(logo|banner)/[0-9a-f-]{36}\.png$' AND EXISTS (
      SELECT 1 FROM public.organizations o JOIN public.org_members om ON om.org_id=o.id
      WHERE o.public_id=split_part(object_name,'/',2) AND NOT o.suspended AND om.user_id=auth.uid() AND om.role IN ('owner','admin')
    ))
  )
$$;

REVOKE ALL ON FUNCTION public.can_read_profile_media(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_read_profile_media(text) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.can_write_profile_media(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_write_profile_media(text) TO authenticated, service_role;

DROP POLICY IF EXISTS "profile_media_read" ON storage.objects;
CREATE POLICY "profile_media_read" ON storage.objects FOR SELECT
  USING (bucket_id = 'profile-media' AND public.can_read_profile_media(name));

DROP POLICY IF EXISTS "profile_media_user_insert" ON storage.objects;
DROP POLICY IF EXISTS "profile_media_org_insert" ON storage.objects;
DROP POLICY IF EXISTS "profile_media_owner_insert" ON storage.objects;
CREATE POLICY "profile_media_owner_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'profile-media'
    AND public.can_write_profile_media(name)
  );

DROP POLICY IF EXISTS "profile_media_owner_delete" ON storage.objects;
CREATE POLICY "profile_media_owner_delete" ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'profile-media' AND public.can_write_profile_media(name)
  );

CREATE OR REPLACE FUNCTION public.get_public_member_profile_v2(p_public_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public SET statement_timeout = '10s'
AS $$
DECLARE base jsonb; media record;
BEGIN
  PERFORM 1 FROM public.profiles
  WHERE public_id = p_public_id AND is_public_profile AND deleted_at IS NULL AND status='ACTIVE';
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'Profile not found'); END IF;
  base := public.get_public_member_profile(p_public_id);
  IF base IS NULL THEN RETURN jsonb_build_object('error', 'Profile not found'); END IF;
  IF base ? 'error' THEN RETURN base; END IF;
  SELECT avatar_storage_path, banner_storage_path INTO media
  FROM public.profiles WHERE public_id = p_public_id AND is_public_profile AND deleted_at IS NULL AND status='ACTIVE';
  RETURN base || jsonb_build_object('avatar_storage_path', media.avatar_storage_path,
    'banner_storage_path', media.banner_storage_path);
END $$;

CREATE OR REPLACE FUNCTION public.get_public_org_profile_v2(p_org_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public SET statement_timeout = '10s'
AS $$
DECLARE base jsonb; media record;
BEGIN
  base := public.get_public_org_profile(p_org_id);
  IF base ? 'error' THEN RETURN base; END IF;
  SELECT logo_storage_path, banner_storage_path INTO media
  FROM public.organizations WHERE id = p_org_id AND NOT suspended;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'Organization not found'); END IF;
  RETURN base || jsonb_build_object('logo_storage_path', media.logo_storage_path,
    'banner_storage_path', media.banner_storage_path);
END $$;

REVOKE ALL ON FUNCTION public.get_public_member_profile_v2(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_public_org_profile_v2(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_member_profile_v2(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_public_org_profile_v2(uuid) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- Safe rollback: stop media uploads first. Retaining private objects/columns is
-- preferred. Dropping them destroys user content and is not routine rollback.
