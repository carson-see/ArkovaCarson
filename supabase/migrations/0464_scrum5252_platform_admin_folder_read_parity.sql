-- SCRUM-5252: make the service-role folder read adapter match the authenticated
-- RLS contract for a verified platform administrator. This is read-only:
-- folder_api_administers_org and every mutation RPC remain unchanged, so
-- personal writes stay owner-only, org writes require exact-org authority, and
-- an API key's org remains an upper bound even when it has a user principal.
--
-- Rollback: restore public.folder_api_list(uuid,uuid,text,uuid,uuid,uuid) from
-- migration 0462 verbatim, then NOTIFY pgrst, 'reload schema'.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.folder_api_list(
  p_actor_user_id uuid,
  p_api_org_id uuid,
  p_owner_scope text,
  p_owner_user_id uuid DEFAULT NULL,
  p_org_id uuid DEFAULT NULL,
  p_context_org_id uuid DEFAULT NULL
) RETURNS SETOF public.folders
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner_user_id uuid := coalesce(p_owner_user_id, p_actor_user_id);
  v_platform_admin boolean := false;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' OR
     (p_actor_user_id IS NULL AND p_api_org_id IS NULL) THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_api_org_id IS NULL AND p_actor_user_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.profiles
       WHERE id = p_actor_user_id AND is_platform_admin IS TRUE
    ) INTO v_platform_admin;
  END IF;

  IF p_owner_scope = 'USER' THEN
    IF v_owner_user_id IS NULL OR
      (p_api_org_id IS NOT NULL AND (
        v_owner_user_id IS DISTINCT FROM p_actor_user_id OR
        p_context_org_id IS DISTINCT FROM p_api_org_id
      )) OR (
      v_owner_user_id IS DISTINCT FROM p_actor_user_id AND
      (p_context_org_id IS NULL OR (
        v_platform_admin IS NOT TRUE AND public.folder_api_administers_org(
          p_actor_user_id, p_api_org_id, p_context_org_id, false) IS NOT TRUE
      ))
    ) THEN RETURN; END IF;
    RETURN QUERY SELECT f.* FROM public.folders f
      WHERE f.owner_scope = 'USER' AND f.user_id = v_owner_user_id
        AND f.context_org_id IS NOT DISTINCT FROM p_context_org_id;
  ELSIF p_owner_scope = 'ORG' AND p_org_id IS NOT NULL AND (
    (p_api_org_id IS NOT NULL AND public.folder_api_administers_org(NULL, p_api_org_id, p_org_id, false)) OR
    (p_api_org_id IS NULL AND (v_platform_admin IS TRUE OR
      public.folder_api_is_member(p_actor_user_id, p_org_id) OR
      public.folder_api_administers_org(p_actor_user_id, NULL, p_org_id, false)))
  ) THEN
    RETURN QUERY SELECT f.* FROM public.folders f
      WHERE f.owner_scope = 'ORG' AND f.org_id = p_org_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.folder_api_list(uuid,uuid,text,uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.folder_api_list(uuid,uuid,text,uuid,uuid,uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
