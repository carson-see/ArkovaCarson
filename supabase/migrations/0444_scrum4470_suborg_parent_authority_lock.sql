-- SCRUM-4470 / SCRUM-4471 / PR #2572: retain parent authority until credit/suspension writes commit.
-- Six real PostgreSQL interleavings reproduced a successful write after the
-- child moved to another parent. Lock the child while reading its parent;
-- READ COMMITTED then observes a committed reparent before authorizing it,
-- and a reparent arriving later waits until the authorized operation commits.
-- Parent administration follows the canonical worker resolver: membership,
-- own-organization profile administrator, or platform administrator.
-- Existing ledger records and migrations 0429-0432 are immutable.
--
-- ROLLBACK: execute 0432_suborg_rpc_role_enum_coercion_fix.sql verbatim, then
-- NOTIFY pgrst, 'reload schema';
-- This restores all six prior definitions
-- (and the two unchanged rollup definitions) with their original service-only
-- ACLs. It reopens the authority race; use only for the documented rehearsal.
-- Migration 0443 and its cap trigger remain unchanged by that rollback.

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

  SELECT parent_org_id INTO v_actual_parent FROM organizations WHERE id = p_child_org_id FOR UPDATE;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('error', 'not_a_sub_org');
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

CREATE OR REPLACE FUNCTION public.suspend_suborg(
  p_parent_org_id uuid,
  p_sub_org_id uuid,
  p_reason text DEFAULT NULL::text
) RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
    SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_caller        uuid := auth.uid();
  v_actual_parent uuid;
  v_already       boolean;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthenticated');
  END IF;

  SELECT parent_org_id INTO v_actual_parent
    FROM organizations WHERE id = p_sub_org_id FOR UPDATE;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_child_of_parent');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = v_caller AND org_id = p_parent_org_id
      AND role::text IN ('owner', 'admin', 'ORG_ADMIN')
  ) AND NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_caller AND (
      (org_id = p_parent_org_id AND role::text = 'ORG_ADMIN')
      OR is_platform_admin = true
    )
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'parent_admin_required');
  END IF;

  SELECT suspended INTO v_already FROM organizations WHERE id = p_sub_org_id FOR UPDATE;
  IF v_already = true THEN
    RETURN jsonb_build_object('success', true, 'already_suspended', true);
  END IF;

  UPDATE organizations
    SET suspended        = true,
        suspended_at     = now(),
        suspended_by     = v_caller,
        suspended_reason = p_reason
    WHERE id = p_sub_org_id;

  -- 0431: real column names (actor_id / details, not actor_user_id / payload),
  -- 0431: and NO exception swallow. If the audit row cannot be written the
  -- 0431: transition must fail — proceeding silently is what hid the defect.
  INSERT INTO audit_events (
    event_type, event_category, actor_id, target_type, target_id, org_id, details
  ) VALUES (
    'org.suborg.suspended', 'ORG', v_caller, 'organization', p_sub_org_id::text, p_parent_org_id,
    json_build_object(
      'parent_org_id', p_parent_org_id,
      'sub_org_id',    p_sub_org_id,
      'reason',        p_reason
    )::text
  );

  RETURN jsonb_build_object(
    'success',      true,
    'sub_org_id',   p_sub_org_id,
    'suspended_at', now(),
    'suspended_by', v_caller,
    'reason',       p_reason
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.unsuspend_suborg(
  p_parent_org_id uuid,
  p_sub_org_id uuid
) RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
    SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_caller        uuid := auth.uid();
  v_actual_parent uuid;
  v_currently     boolean;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthenticated');
  END IF;

  SELECT parent_org_id INTO v_actual_parent
    FROM organizations WHERE id = p_sub_org_id FOR UPDATE;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_child_of_parent');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = v_caller AND org_id = p_parent_org_id
      AND role::text IN ('owner', 'admin', 'ORG_ADMIN')
  ) AND NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_caller AND (
      (org_id = p_parent_org_id AND role::text = 'ORG_ADMIN')
      OR is_platform_admin = true
    )
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'parent_admin_required');
  END IF;

  SELECT suspended INTO v_currently FROM organizations WHERE id = p_sub_org_id FOR UPDATE;
  IF v_currently = false THEN
    RETURN jsonb_build_object('success', true, 'was_already_active', true);
  END IF;

  UPDATE organizations
    SET suspended        = false,
        suspended_at     = null,
        suspended_by     = null,
        suspended_reason = null
    WHERE id = p_sub_org_id;

  -- 0431: see the note in suspend_suborg above.
  INSERT INTO audit_events (
    event_type, event_category, actor_id, target_type, target_id, org_id, details
  ) VALUES (
    'org.suborg.unsuspended', 'ORG', v_caller, 'organization', p_sub_org_id::text, p_parent_org_id,
    json_build_object(
      'parent_org_id', p_parent_org_id,
      'sub_org_id',    p_sub_org_id
    )::text
  );

  RETURN jsonb_build_object('success', true, 'sub_org_id', p_sub_org_id, 'unsuspended_at', now());
END;
$function$;

CREATE OR REPLACE FUNCTION public.suspend_suborg(
  p_parent_org_id uuid,
  p_sub_org_id uuid,
  p_reason text,
  p_caller_user_id uuid
) RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
    SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_caller        uuid := p_caller_user_id;   -- 0431: was auth.uid()
  v_actual_parent uuid;
  v_already       boolean;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthenticated');
  END IF;

  SELECT parent_org_id INTO v_actual_parent
    FROM organizations WHERE id = p_sub_org_id FOR UPDATE;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_child_of_parent');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = v_caller AND org_id = p_parent_org_id
      AND role::text IN ('owner', 'admin', 'ORG_ADMIN')
  ) AND NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_caller AND (
      (org_id = p_parent_org_id AND role::text = 'ORG_ADMIN')
      OR is_platform_admin = true
    )
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'parent_admin_required');
  END IF;

  SELECT suspended INTO v_already FROM organizations WHERE id = p_sub_org_id FOR UPDATE;
  IF v_already = true THEN
    RETURN jsonb_build_object('success', true, 'already_suspended', true);
  END IF;

  UPDATE organizations
    SET suspended        = true,
        suspended_at     = now(),
        suspended_by     = v_caller,
        suspended_reason = p_reason
    WHERE id = p_sub_org_id;

  INSERT INTO audit_events (
    event_type, event_category, actor_id, target_type, target_id, org_id, details
  ) VALUES (
    'org.suborg.suspended', 'ORG', v_caller, 'organization', p_sub_org_id::text, p_parent_org_id,
    json_build_object(
      'parent_org_id', p_parent_org_id,
      'sub_org_id',    p_sub_org_id,
      'reason',        p_reason
    )::text
  );

  RETURN jsonb_build_object(
    'success',      true,
    'sub_org_id',   p_sub_org_id,
    'suspended_at', now(),
    'suspended_by', v_caller,
    'reason',       p_reason
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.unsuspend_suborg(
  p_parent_org_id uuid,
  p_sub_org_id uuid,
  p_caller_user_id uuid
) RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
    SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_caller        uuid := p_caller_user_id;   -- 0431: was auth.uid()
  v_actual_parent uuid;
  v_currently     boolean;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthenticated');
  END IF;

  SELECT parent_org_id INTO v_actual_parent
    FROM organizations WHERE id = p_sub_org_id FOR UPDATE;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_child_of_parent');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = v_caller AND org_id = p_parent_org_id
      AND role::text IN ('owner', 'admin', 'ORG_ADMIN')
  ) AND NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_caller AND (
      (org_id = p_parent_org_id AND role::text = 'ORG_ADMIN')
      OR is_platform_admin = true
    )
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'parent_admin_required');
  END IF;

  SELECT suspended INTO v_currently FROM organizations WHERE id = p_sub_org_id FOR UPDATE;
  IF v_currently = false THEN
    RETURN jsonb_build_object('success', true, 'was_already_active', true);
  END IF;

  UPDATE organizations
    SET suspended        = false,
        suspended_at     = null,
        suspended_by     = null,
        suspended_reason = null
    WHERE id = p_sub_org_id;

  INSERT INTO audit_events (
    event_type, event_category, actor_id, target_type, target_id, org_id, details
  ) VALUES (
    'org.suborg.unsuspended', 'ORG', v_caller, 'organization', p_sub_org_id::text, p_parent_org_id,
    json_build_object(
      'parent_org_id', p_parent_org_id,
      'sub_org_id',    p_sub_org_id
    )::text
  );

  RETURN jsonb_build_object('success', true, 'sub_org_id', p_sub_org_id, 'unsuspended_at', now());
END;
$function$;

CREATE OR REPLACE FUNCTION public.allocate_credits_to_sub_org(p_parent_org_id uuid, p_child_org_id uuid, p_amount integer, p_note text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
    SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_caller         uuid := auth.uid();
  v_parent_balance integer;
  v_child_balance  integer;
  v_actual_parent  uuid;
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
  SELECT parent_org_id INTO v_actual_parent FROM organizations WHERE id = p_child_org_id FOR UPDATE;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('error', 'not_a_sub_org');
  END IF;
  PERFORM 1 FROM org_credits WHERE org_id = LEAST(p_parent_org_id, p_child_org_id) FOR UPDATE;
  PERFORM 1 FROM org_credits WHERE org_id = GREATEST(p_parent_org_id, p_child_org_id) FOR UPDATE;
  INSERT INTO org_credits (org_id) VALUES (p_parent_org_id) ON CONFLICT (org_id) DO NOTHING;
  INSERT INTO org_credits (org_id) VALUES (p_child_org_id)  ON CONFLICT (org_id) DO NOTHING;
  SELECT balance INTO v_parent_balance FROM org_credits WHERE org_id = p_parent_org_id FOR UPDATE;
  IF p_amount > 0 AND v_parent_balance < p_amount THEN
    RETURN jsonb_build_object('error', 'insufficient_parent_balance', 'parent_balance', v_parent_balance, 'requested', p_amount);
  END IF;
  IF p_amount < 0 THEN
    SELECT balance INTO v_child_balance FROM org_credits WHERE org_id = p_child_org_id FOR UPDATE;
    IF v_child_balance < ABS(p_amount) THEN
      RETURN jsonb_build_object('error', 'insufficient_child_balance', 'child_balance', v_child_balance, 'requested', p_amount);
    END IF;
  END IF;
  UPDATE org_credits SET balance = balance - p_amount, updated_at = now() WHERE org_id = p_parent_org_id;
  UPDATE org_credits SET balance = balance + p_amount, updated_at = now() WHERE org_id = p_child_org_id;
  INSERT INTO org_credit_allocations (parent_org_id, child_org_id, amount, granted_by, note)
  VALUES (p_parent_org_id, p_child_org_id, p_amount, v_caller, p_note);
  INSERT INTO audit_events (event_type, event_category, actor_id, target_type, target_id, org_id, details)
  VALUES ('ORG_CREDIT_ALLOCATED', 'ORG', v_caller, 'organization', p_child_org_id::text, p_parent_org_id,
    json_build_object('amount', p_amount, 'parent_org_id', p_parent_org_id, 'child_org_id', p_child_org_id, 'note', p_note)::text);
  RETURN jsonb_build_object('success', true, 'parent_balance', v_parent_balance - p_amount,
    'child_balance', (SELECT balance FROM org_credits WHERE org_id = p_child_org_id));
END;
$function$;

REVOKE ALL ON FUNCTION public.allocate_credits_to_sub_org(uuid, uuid, integer, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_credits_to_sub_org(uuid, uuid, integer, text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.suspend_suborg(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.suspend_suborg(uuid, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.unsuspend_suborg(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unsuspend_suborg(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.suspend_suborg(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.suspend_suborg(uuid, uuid, text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.unsuspend_suborg(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unsuspend_suborg(uuid, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.allocate_credits_to_sub_org(uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_credits_to_sub_org(uuid, uuid, integer, text) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
