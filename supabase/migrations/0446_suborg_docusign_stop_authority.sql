-- PR #2572: retain current parent authority throughout DocuSign inheritance stop.
-- An observed marker alone does not prove the child still belongs to the parent.
-- Lock the child, recheck canonical administration, and revoke only the inspected
-- active marker. Valid owned DocuSign accounts remain untouched.
--
-- ROLLBACK: disabling this RPC makes its worker route fail closed with HTTP 503.
-- BEGIN;
-- SET LOCAL lock_timeout = '5s';
-- DROP FUNCTION IF EXISTS public.stop_suborg_docusign_inheritance(uuid, uuid, uuid, uuid, uuid, timestamptz);
-- NOTIFY pgrst, 'reload schema';
-- COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.stop_suborg_docusign_inheritance(
  p_parent_org_id uuid,
  p_child_org_id uuid,
  p_integration_id uuid,
  p_inherited_from_org_id uuid,
  p_caller_user_id uuid,
  p_revoked_at timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_actual_parent uuid;
  v_revoked_id uuid;
BEGIN
  IF p_caller_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'authentication_required');
  END IF;

  -- A committed reparent is observed after waiting at READ COMMITTED; a
  -- reparent arriving later waits until this authorized revocation commits.
  SELECT parent_org_id INTO v_actual_parent
    FROM public.organizations WHERE id = p_child_org_id FOR UPDATE;
  IF NOT FOUND OR v_actual_parent IS NULL OR v_actual_parent IS DISTINCT FROM p_parent_org_id THEN
    RETURN jsonb_build_object('error', 'child_parent_changed');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.org_members
    WHERE user_id = p_caller_user_id AND org_id = p_parent_org_id
      AND role::text IN ('owner', 'admin', 'ORG_ADMIN')
  ) AND NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_caller_user_id AND (
      (org_id = p_parent_org_id AND role::text = 'ORG_ADMIN')
      OR is_platform_admin = true
    )
  ) THEN
    RETURN jsonb_build_object('error', 'parent_admin_required');
  END IF;

  UPDATE public.org_integrations
     SET revoked_at = COALESCE(p_revoked_at, now())
   WHERE id = p_integration_id
     AND org_id = p_child_org_id
     AND provider = 'docusign'
     AND inherited_from_org_id = p_inherited_from_org_id
     AND revoked_at IS NULL
   RETURNING id INTO v_revoked_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'inherited_connection_changed');
  END IF;

  -- Audit and revocation succeed together; audit failure rolls the write back.
  INSERT INTO public.audit_events (
    event_type, event_category, actor_id, target_type, target_id, org_id, details
  ) VALUES (
    'org.integration.inheritance_stopped', 'ORG', p_caller_user_id,
    'organization', p_child_org_id::text, p_parent_org_id,
    json_build_object(
      'parent_org_id', p_parent_org_id,
      'child_org_id', p_child_org_id,
      'integration_id', v_revoked_id,
      'inherited_from_org_id', p_inherited_from_org_id
    )::text
  );
  RETURN jsonb_build_object('success', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.stop_suborg_docusign_inheritance(uuid, uuid, uuid, uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stop_suborg_docusign_inheritance(uuid, uuid, uuid, uuid, uuid, timestamptz) TO service_role;
COMMENT ON FUNCTION public.stop_suborg_docusign_inheritance(uuid, uuid, uuid, uuid, uuid, timestamptz) IS
  'Service-only atomic inheritance stop: current-parent row lock, canonical admin authorization, scoped marker revocation and audit.';

NOTIFY pgrst, 'reload schema';
COMMIT;
