-- Fixture extension for 0431. Loaded AFTER fixture-0429.sql + fixture-0430.sql.
-- The two pre-0431 function bodies are the LIVE PROD definitions captured this
-- session via pg_get_functiondef — including the broken audit insert, which is
-- the point: the red baseline has to reproduce the real defect, not a mock-up.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS suspended boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_by uuid,
  ADD COLUMN IF NOT EXISTS suspended_reason text;

CREATE OR REPLACE FUNCTION public.suspend_suborg(p_parent_org_id uuid, p_sub_org_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_caller        uuid := auth.uid();
  v_actual_parent uuid;
  v_already       boolean;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthenticated');
  END IF;
  SELECT parent_org_id INTO v_actual_parent FROM organizations WHERE id = p_sub_org_id;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_child_of_parent');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM org_members WHERE user_id = v_caller AND org_id = p_parent_org_id
      AND role IN ('owner', 'admin', 'ORG_ADMIN')
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'parent_admin_required');
  END IF;
  SELECT suspended INTO v_already FROM organizations WHERE id = p_sub_org_id FOR UPDATE;
  IF v_already = true THEN
    RETURN jsonb_build_object('success', true, 'already_suspended', true);
  END IF;
  UPDATE organizations
    SET suspended = true, suspended_at = now(), suspended_by = v_caller, suspended_reason = p_reason
    WHERE id = p_sub_org_id;
  -- THE DEFECT, verbatim from prod: actor_user_id / payload do not exist, and
  -- the failure is swallowed.
  BEGIN
    INSERT INTO audit_events (org_id, event_type, actor_user_id, payload)
    VALUES (p_parent_org_id, 'org.suborg.suspended', v_caller,
      jsonb_build_object('parent_org_id', p_parent_org_id, 'sub_org_id', p_sub_org_id,
                         'reason', p_reason, 'at', now()));
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'suspend_suborg: audit_events insert failed: %', SQLERRM;
  END;
  RETURN jsonb_build_object('success', true, 'sub_org_id', p_sub_org_id,
    'suspended_at', now(), 'suspended_by', v_caller, 'reason', p_reason);
END;
$function$;

CREATE OR REPLACE FUNCTION public.unsuspend_suborg(p_parent_org_id uuid, p_sub_org_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_caller        uuid := auth.uid();
  v_actual_parent uuid;
  v_currently     boolean;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthenticated');
  END IF;
  SELECT parent_org_id INTO v_actual_parent FROM organizations WHERE id = p_sub_org_id;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_child_of_parent');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM org_members WHERE user_id = v_caller AND org_id = p_parent_org_id
      AND role IN ('owner', 'admin', 'ORG_ADMIN')
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'parent_admin_required');
  END IF;
  SELECT suspended INTO v_currently FROM organizations WHERE id = p_sub_org_id FOR UPDATE;
  IF v_currently = false THEN
    RETURN jsonb_build_object('success', true, 'was_already_active', true);
  END IF;
  UPDATE organizations
    SET suspended = false, suspended_at = null, suspended_by = null, suspended_reason = null
    WHERE id = p_sub_org_id;
  BEGIN
    INSERT INTO audit_events (org_id, event_type, actor_user_id, payload)
    VALUES (p_parent_org_id, 'org.suborg.unsuspended', v_caller,
      jsonb_build_object('parent_org_id', p_parent_org_id, 'sub_org_id', p_sub_org_id, 'at', now()));
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'unsuspend_suborg: audit_events insert failed: %', SQLERRM;
  END;
  RETURN jsonb_build_object('success', true, 'sub_org_id', p_sub_org_id, 'unsuspended_at', now());
END;
$function$;
