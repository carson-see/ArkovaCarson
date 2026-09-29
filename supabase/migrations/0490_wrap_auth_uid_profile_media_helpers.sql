-- 0490_wrap_auth_uid_profile_media_helpers.sql
-- SCRUM-1278 (R3-5) compensating migration for 0481 (PR #3033, UAT-14 profile
-- brand media, applied to prod 2026-09-20). 0481 introduced five bare
-- `auth.uid()` calls. They are NOT in the three storage policies
-- (`profile_media_read` / `profile_media_owner_insert` /
-- `profile_media_owner_delete` on storage.objects, verified on prod
-- vzwyaatejekddvltxyye via pg_policies 2026-09-27) — those predicates only call
-- the two SECURITY DEFINER helpers below. The bare calls live inside the helper
-- bodies: two in `can_read_profile_media`, three in `can_write_profile_media`.
-- Postgres evaluates the policy helper once per candidate storage.objects row,
-- so each bare call re-reads the JWT per row; `(SELECT auth.uid())` lets the
-- planner hoist it into a cached initplan (0280 did the same for every policy
-- that existed at the time).
--
-- Only the five calls change. Predicates, grants, volatility, search_path and
-- the storage policies are byte-for-byte the same semantics, so no
-- DROP/CREATE POLICY is needed and none is issued (a policy DROP on
-- storage.objects would take an AccessExclusiveLock for nothing). CREATE OR
-- REPLACE preserves the function ACL set by 0481; the REVOKE/GRANT lines are
-- restated so the file is self-describing and idempotent.
--
-- No hot-table DDL here; the lock_timeout guard is kept anyway per CLAUDE.md
-- §1.2 so a future edit to this file cannot silently lose it.
--
-- ROLLBACK: re-run the two CREATE OR REPLACE FUNCTION statements from
-- ROLLBACK: supabase/migrations/0481_uat14_profile_brand_media.sql
-- ROLLBACK: (can_read_profile_media and can_write_profile_media, the forms with
-- ROLLBACK: bare `p.id = auth.uid()` / `om.user_id=auth.uid()` /
-- ROLLBACK: `actor.id=auth.uid()`) followed by NOTIFY pgrst, 'reload schema'.
-- ROLLBACK: The 0481 bodies are reproduced verbatim at the end of this file
-- ROLLBACK: inside a comment block so the rollback needs no other source.

BEGIN;
SET LOCAL lock_timeout = '5s';

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
            AND ((p.id = (SELECT auth.uid()) AND p.status='ACTIVE' AND private.is_human_mfa_verified())
              OR (p.is_public_profile AND p.status='ACTIVE' AND object_name IN (p.avatar_storage_path, p.banner_storage_path)))
        )
    WHEN object_name ~ '^organizations/[A-Za-z0-9_-]{3,128}/(logo|banner)/[0-9a-f-]{36}\.png$'
      THEN EXISTS (
        SELECT 1 FROM public.organizations o
        WHERE o.public_id = split_part(object_name, '/', 2)
          AND NOT o.suspended
          AND (object_name IN (o.logo_storage_path, o.banner_storage_path) OR EXISTS (
            SELECT 1 FROM public.org_members om JOIN public.profiles actor ON actor.id=om.user_id
            WHERE om.org_id=o.id AND om.user_id=(SELECT auth.uid()) AND om.role IN ('owner','admin')
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
    SELECT 1 FROM public.profiles actor WHERE actor.id=(SELECT auth.uid()) AND actor.deleted_at IS NULL AND actor.status='ACTIVE'
  ) AND (
    (object_name ~ '^users/[A-Za-z0-9_-]{3,128}/(avatar|banner)/[0-9a-f-]{36}\.png$' AND EXISTS (
      SELECT 1 FROM public.profiles p WHERE p.id=(SELECT auth.uid()) AND p.public_id=split_part(object_name,'/',2)
    )) OR
    (object_name ~ '^organizations/[A-Za-z0-9_-]{3,128}/(logo|banner)/[0-9a-f-]{36}\.png$' AND EXISTS (
      SELECT 1 FROM public.organizations o JOIN public.org_members om ON om.org_id=o.id
      WHERE o.public_id=split_part(object_name,'/',2) AND NOT o.suspended AND om.user_id=(SELECT auth.uid()) AND om.role IN ('owner','admin')
    ))
  )
$$;

REVOKE ALL ON FUNCTION public.can_read_profile_media(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_read_profile_media(text) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.can_write_profile_media(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_write_profile_media(text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- ROLLBACK bodies — the exact 0481 definitions this migration replaces.
--    Run inside BEGIN; SET LOCAL lock_timeout = '5s'; ... NOTIFY pgrst, 'reload schema'; COMMIT;
--
-- CREATE OR REPLACE FUNCTION public.can_read_profile_media(object_name text)
-- RETURNS boolean
-- LANGUAGE sql STABLE SECURITY DEFINER
-- SET search_path = public
-- AS $$
--   SELECT CASE
--     WHEN object_name ~ '^users/[A-Za-z0-9_-]{3,128}/(avatar|banner)/[0-9a-f-]{36}\.png$'
--       THEN EXISTS (
--           SELECT 1 FROM public.profiles p
--           WHERE p.public_id = split_part(object_name, '/', 2) AND p.deleted_at IS NULL
--             AND ((p.id = auth.uid() AND p.status='ACTIVE' AND private.is_human_mfa_verified())
--               OR (p.is_public_profile AND p.status='ACTIVE' AND object_name IN (p.avatar_storage_path, p.banner_storage_path)))
--         )
--     WHEN object_name ~ '^organizations/[A-Za-z0-9_-]{3,128}/(logo|banner)/[0-9a-f-]{36}\.png$'
--       THEN EXISTS (
--         SELECT 1 FROM public.organizations o
--         WHERE o.public_id = split_part(object_name, '/', 2)
--           AND NOT o.suspended
--           AND (object_name IN (o.logo_storage_path, o.banner_storage_path) OR EXISTS (
--             SELECT 1 FROM public.org_members om JOIN public.profiles actor ON actor.id=om.user_id
--             WHERE om.org_id=o.id AND om.user_id=auth.uid() AND om.role IN ('owner','admin')
--               AND actor.deleted_at IS NULL AND actor.status='ACTIVE' AND private.is_human_mfa_verified()
--           ))
--       )
--     ELSE false
--   END
-- $$;
--
-- CREATE OR REPLACE FUNCTION public.can_write_profile_media(object_name text)
-- RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
-- AS $$
--   SELECT private.is_human_mfa_verified() AND EXISTS (
--     SELECT 1 FROM public.profiles actor WHERE actor.id=auth.uid() AND actor.deleted_at IS NULL AND actor.status='ACTIVE'
--   ) AND (
--     (object_name ~ '^users/[A-Za-z0-9_-]{3,128}/(avatar|banner)/[0-9a-f-]{36}\.png$' AND EXISTS (
--       SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.public_id=split_part(object_name,'/',2)
--     )) OR
--     (object_name ~ '^organizations/[A-Za-z0-9_-]{3,128}/(logo|banner)/[0-9a-f-]{36}\.png$' AND EXISTS (
--       SELECT 1 FROM public.organizations o JOIN public.org_members om ON om.org_id=o.id
--       WHERE o.public_id=split_part(object_name,'/',2) AND NOT o.suspended AND om.user_id=auth.uid() AND om.role IN ('owner','admin')
--     ))
--   )
-- $$;
--
