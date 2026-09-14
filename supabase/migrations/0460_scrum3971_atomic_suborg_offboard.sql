-- SCRUM-3971 / CTO #2844 review: offboarding and allocation share one transaction boundary.
-- 0453 has already been applied to a staging database and is immutable.
--
-- The old worker read a balance, reclaimed it, then suspended in separate RPCs.
-- Allocation between those calls (or after a stale HTTP precheck) could strand
-- new credits in a suspended child. The new offboard RPC holds the child row
-- and ordered credit-row locks across reclaim, suspension and both audits.
-- Any error after reclaim raises, rolling back the entire transaction.
-- Positive allocations recheck approval/suspension under the same child lock.
-- Negative reclaim remains available for revoked, pending or suspended children.
--
-- No table, RLS policy or existing authority predicate changes. Definer RPCs
-- remain service_role-only, including the legacy auth.uid() allocation wrapper.
-- Credit-row locks retain the existing LEAST/GREATEST order; no table DDL is used.
--
-- ROLLBACK: containment, after stopping new offboard traffic and reverting the
-- worker to the pre-feature release. Retain the guarded allocation definitions.
-- BEGIN;
-- SET LOCAL lock_timeout = '5s';
-- REVOKE EXECUTE ON FUNCTION public.offboard_suborg(uuid, uuid, text, uuid) FROM service_role;
-- REVOKE EXECUTE ON FUNCTION public.offboard_suborg_as_api_key(uuid, uuid, text, uuid) FROM service_role;
-- NOTIFY pgrst, 'reload schema';
-- COMMIT;
-- Reapply this file to re-enable. Restoring the old two-call worker or the
-- unguarded 0444/0453 writers reopens the proven race and is not a safe rollback.
-- Existing records and 0453 stay untouched.

BEGIN;
SET LOCAL lock_timeout = '5s';


CREATE OR REPLACE FUNCTION public.allocate_credits_to_sub_org(
  p_parent_org_id uuid,
  p_child_org_id uuid,
  p_amount integer,
  p_note text,
  p_caller_user_id uuid
) RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
    SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_caller         uuid := p_caller_user_id;   -- 0430: was auth.uid()
  v_parent_balance integer;
  v_child_balance  integer;
  v_actual_parent  uuid;
  v_approval text;
  v_suspended boolean;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('error', 'authentication_required');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = v_caller AND org_id = p_parent_org_id AND role::text IN ('owner', 'admin', 'ORG_ADMIN')
  ) AND NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_caller AND (
      (org_id = p_parent_org_id AND role::text = 'ORG_ADMIN')
      OR is_platform_admin = true
    )
  ) THEN
    RETURN jsonb_build_object('error', 'parent_admin_required');
  END IF;

  SELECT parent_org_id, parent_approval_status::text, suspended
    INTO v_actual_parent, v_approval, v_suspended
    FROM organizations WHERE id = p_child_org_id FOR UPDATE;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('error', 'not_a_sub_org');
  END IF;

  -- This must follow the lock: the HTTP precheck can predate offboarding.
  IF p_amount > 0 AND (v_approval IS DISTINCT FROM 'APPROVED' OR v_suspended IS DISTINCT FROM false) THEN
    RETURN jsonb_build_object('error', 'sub_org_not_active');
  END IF;

  PERFORM 1 FROM org_credits WHERE org_id = LEAST(p_parent_org_id, p_child_org_id) FOR UPDATE;
  PERFORM 1 FROM org_credits WHERE org_id = GREATEST(p_parent_org_id, p_child_org_id) FOR UPDATE;

  INSERT INTO org_credits (org_id) VALUES (p_parent_org_id) ON CONFLICT (org_id) DO NOTHING;
  INSERT INTO org_credits (org_id) VALUES (p_child_org_id)  ON CONFLICT (org_id) DO NOTHING;

  SELECT balance INTO v_parent_balance FROM org_credits WHERE org_id = p_parent_org_id FOR UPDATE;

  IF p_amount > 0 AND v_parent_balance < p_amount THEN
    RETURN jsonb_build_object(
      'error', 'insufficient_parent_balance',
      'parent_balance', v_parent_balance,
      'requested', p_amount
    );
  END IF;

  IF p_amount < 0 THEN
    SELECT balance INTO v_child_balance FROM org_credits WHERE org_id = p_child_org_id FOR UPDATE;
    IF v_child_balance < ABS(p_amount) THEN
      RETURN jsonb_build_object(
        'error', 'insufficient_child_balance',
        'child_balance', v_child_balance,
        'requested', p_amount
      );
    END IF;
  END IF;

  UPDATE org_credits SET balance = balance - p_amount, updated_at = now() WHERE org_id = p_parent_org_id;
  UPDATE org_credits SET balance = balance + p_amount, updated_at = now() WHERE org_id = p_child_org_id;

  INSERT INTO org_credit_allocations (parent_org_id, child_org_id, amount, granted_by, note)
  VALUES (p_parent_org_id, p_child_org_id, p_amount, v_caller, p_note);

  INSERT INTO audit_events (
    event_type, event_category, actor_id, target_type, target_id, org_id, details
  ) VALUES (
    'ORG_CREDIT_ALLOCATED', 'ORG', v_caller, 'organization', p_child_org_id::text, p_parent_org_id,
    json_build_object(
      'amount', p_amount,
      'parent_org_id', p_parent_org_id,
      'child_org_id', p_child_org_id,
      'note', p_note
    )::text
  );

  RETURN jsonb_build_object(
    'success', true,
    'parent_balance', v_parent_balance - p_amount,
    'child_balance', (SELECT balance FROM org_credits WHERE org_id = p_child_org_id)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.allocate_credits_to_sub_org_as_api_key(
  p_parent_org_id uuid,
  p_child_org_id uuid,
  p_amount integer,
  p_note text,
  p_caller_api_key_id uuid
) RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
    SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_principal      uuid;
  v_key_prefix     text;
  v_parent_balance integer;
  v_child_balance  integer;
  v_actual_parent  uuid;
  v_approval text;
  v_suspended boolean;
BEGIN
  IF p_caller_api_key_id IS NULL THEN
    RETURN jsonb_build_object('error', 'authentication_required');
  END IF;

  IF NOT public._suborg_api_key_authorized(p_parent_org_id, p_caller_api_key_id) THEN
    RETURN jsonb_build_object('error', 'parent_admin_required');
  END IF;

  SELECT created_by, key_prefix INTO v_principal, v_key_prefix
    FROM api_keys WHERE id = p_caller_api_key_id;
  IF v_principal IS NULL THEN
    RETURN jsonb_build_object('error', 'api_key_principal_unresolved');
  END IF;

  SELECT parent_org_id, parent_approval_status::text, suspended
    INTO v_actual_parent, v_approval, v_suspended
    FROM organizations WHERE id = p_child_org_id FOR UPDATE;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('error', 'not_a_sub_org');
  END IF;

  -- This must follow the lock: the HTTP precheck can predate offboarding.
  IF p_amount > 0 AND (v_approval IS DISTINCT FROM 'APPROVED' OR v_suspended IS DISTINCT FROM false) THEN
    RETURN jsonb_build_object('error', 'sub_org_not_active');
  END IF;

  PERFORM 1 FROM org_credits WHERE org_id = LEAST(p_parent_org_id, p_child_org_id) FOR UPDATE;
  PERFORM 1 FROM org_credits WHERE org_id = GREATEST(p_parent_org_id, p_child_org_id) FOR UPDATE;

  INSERT INTO org_credits (org_id) VALUES (p_parent_org_id) ON CONFLICT (org_id) DO NOTHING;
  INSERT INTO org_credits (org_id) VALUES (p_child_org_id)  ON CONFLICT (org_id) DO NOTHING;

  SELECT balance INTO v_parent_balance FROM org_credits WHERE org_id = p_parent_org_id FOR UPDATE;

  IF p_amount > 0 AND v_parent_balance < p_amount THEN
    RETURN jsonb_build_object(
      'error', 'insufficient_parent_balance',
      'parent_balance', v_parent_balance,
      'requested', p_amount
    );
  END IF;

  IF p_amount < 0 THEN
    SELECT balance INTO v_child_balance FROM org_credits WHERE org_id = p_child_org_id FOR UPDATE;
    IF v_child_balance < ABS(p_amount) THEN
      RETURN jsonb_build_object(
        'error', 'insufficient_child_balance',
        'child_balance', v_child_balance,
        'requested', p_amount
      );
    END IF;
  END IF;

  UPDATE org_credits SET balance = balance - p_amount, updated_at = now() WHERE org_id = p_parent_org_id;
  UPDATE org_credits SET balance = balance + p_amount, updated_at = now() WHERE org_id = p_child_org_id;

  INSERT INTO org_credit_allocations (parent_org_id, child_org_id, amount, granted_by, note)
  VALUES (p_parent_org_id, p_child_org_id, p_amount, v_principal, p_note);

  INSERT INTO audit_events (
    event_type, event_category, actor_id, target_type, target_id, org_id, details
  ) VALUES (
    'ORG_CREDIT_ALLOCATED', 'ORG', NULL, 'organization', p_child_org_id::text, p_parent_org_id,
    json_build_object(
      'amount', p_amount,
      'parent_org_id', p_parent_org_id,
      'child_org_id', p_child_org_id,
      'note', p_note,
      'actor', json_build_object(
        'actor_kind', 'api_key',
        'actor_api_key_id', p_caller_api_key_id,
        'actor_key_prefix', v_key_prefix
      )
    )::text
  );

  RETURN jsonb_build_object(
    'success', true,
    'parent_balance', v_parent_balance - p_amount,
    'child_balance', (SELECT balance FROM org_credits WHERE org_id = p_child_org_id)
  );
END;
$function$;

-- Keep the legacy caller on the same guarded implementation.
CREATE OR REPLACE FUNCTION public.allocate_credits_to_sub_org(
  p_parent_org_id uuid, p_child_org_id uuid, p_amount integer,
  p_note text DEFAULT NULL::text
) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
    SET lock_timeout TO '5s'
AS $function$
  SELECT public.allocate_credits_to_sub_org(
    p_parent_org_id, p_child_org_id, p_amount, p_note, auth.uid()
  );
$function$;

CREATE OR REPLACE FUNCTION public.offboard_suborg(
  p_parent_org_id uuid, p_sub_org_id uuid, p_reason text, p_caller_user_id uuid
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
    SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_actual_parent uuid;
  v_balance integer;
  v_result jsonb;
BEGIN
  IF p_caller_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  IF NOT (EXISTS (
    SELECT 1 FROM org_members WHERE user_id = p_caller_user_id AND org_id = p_parent_org_id
      AND role::text IN ('owner', 'admin', 'ORG_ADMIN')
  ) OR EXISTS (
    SELECT 1 FROM profiles WHERE id = p_caller_user_id AND (
      (org_id = p_parent_org_id AND role::text = 'ORG_ADMIN') OR is_platform_admin = true
    )
  )) THEN
    RETURN jsonb_build_object('success', false, 'error', 'parent_admin_required');
  END IF;

  SELECT parent_org_id INTO v_actual_parent
    FROM organizations WHERE id = p_sub_org_id FOR UPDATE;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_child_of_parent');
  END IF;

  PERFORM 1 FROM org_credits WHERE org_id = LEAST(p_parent_org_id, p_sub_org_id) FOR UPDATE;
  PERFORM 1 FROM org_credits WHERE org_id = GREATEST(p_parent_org_id, p_sub_org_id) FOR UPDATE;
  SELECT balance INTO v_balance FROM org_credits WHERE org_id = p_sub_org_id;
  v_balance := COALESCE(v_balance, 0);

  IF v_balance > 0 THEN
    v_result := public.allocate_credits_to_sub_org(
      p_parent_org_id, p_sub_org_id, -v_balance,
      CASE WHEN p_reason IS NULL THEN 'offboarding' ELSE 'offboarding: ' || p_reason END,
      p_caller_user_id
    );
    IF v_result->>'success' IS DISTINCT FROM 'true' THEN
      -- No credit or suspension write can be reported as partially committed.
      RAISE EXCEPTION 'suborg_offboard_reclaim_failed';
    END IF;
  END IF;

  v_result := public.suspend_suborg(p_parent_org_id, p_sub_org_id, p_reason, p_caller_user_id);
  IF v_result->>'success' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'suborg_offboard_suspend_failed';
  END IF;
  RETURN jsonb_build_object(
    'success', true, 'reclaimed', v_balance,
    'already_suspended', COALESCE((v_result->>'already_suspended')::boolean, false)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.offboard_suborg_as_api_key(
  p_parent_org_id uuid, p_sub_org_id uuid, p_reason text, p_caller_api_key_id uuid
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
    SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_actual_parent uuid;
  v_balance integer;
  v_result jsonb;
BEGIN
  IF p_caller_api_key_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  IF NOT public._suborg_api_key_authorized(p_parent_org_id, p_caller_api_key_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'parent_admin_required');
  END IF;

  SELECT parent_org_id INTO v_actual_parent
    FROM organizations WHERE id = p_sub_org_id FOR UPDATE;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_child_of_parent');
  END IF;

  PERFORM 1 FROM org_credits WHERE org_id = LEAST(p_parent_org_id, p_sub_org_id) FOR UPDATE;
  PERFORM 1 FROM org_credits WHERE org_id = GREATEST(p_parent_org_id, p_sub_org_id) FOR UPDATE;
  SELECT balance INTO v_balance FROM org_credits WHERE org_id = p_sub_org_id;
  v_balance := COALESCE(v_balance, 0);

  IF v_balance > 0 THEN
    v_result := public.allocate_credits_to_sub_org_as_api_key(
      p_parent_org_id, p_sub_org_id, -v_balance,
      CASE WHEN p_reason IS NULL THEN 'offboarding' ELSE 'offboarding: ' || p_reason END,
      p_caller_api_key_id
    );
    IF v_result->>'success' IS DISTINCT FROM 'true' THEN
      -- No credit or suspension write can be reported as partially committed.
      RAISE EXCEPTION 'suborg_offboard_reclaim_failed';
    END IF;
  END IF;

  v_result := public.suspend_suborg_as_api_key(p_parent_org_id, p_sub_org_id, p_reason, p_caller_api_key_id);
  IF v_result->>'success' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'suborg_offboard_suspend_failed';
  END IF;
  RETURN jsonb_build_object(
    'success', true, 'reclaimed', v_balance,
    'already_suspended', COALESCE((v_result->>'already_suspended')::boolean, false)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.allocate_credits_to_sub_org(uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_credits_to_sub_org(uuid, uuid, integer, text) TO service_role;

REVOKE ALL ON FUNCTION public.allocate_credits_to_sub_org(uuid, uuid, integer, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_credits_to_sub_org(uuid, uuid, integer, text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.allocate_credits_to_sub_org_as_api_key(uuid, uuid, integer, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_credits_to_sub_org_as_api_key(uuid, uuid, integer, text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.offboard_suborg(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.offboard_suborg(uuid, uuid, text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.offboard_suborg_as_api_key(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.offboard_suborg_as_api_key(uuid, uuid, text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
