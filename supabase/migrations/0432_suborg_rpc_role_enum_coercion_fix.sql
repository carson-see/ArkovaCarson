-- =============================================================================
-- 0432 — Sub-org RPCs compare an enum against a label that does not exist
--        (SCRUM-3875, epic SCRUM-3863)
--
-- A LIVE PRODUCTION DEFECT. `org_members.role` is the enum `org_member_role`,
-- whose labels are exactly: owner, admin, member, compliance_officer. Four
-- SECURITY DEFINER functions gate on
--
--     role IN ('owner', 'admin', 'ORG_ADMIN')
--
-- and 'ORG_ADMIN' is NOT a label of that type. Postgres coerces each literal to
-- the enum, so the comparison raises
--
--     22P02 invalid input value for enum org_member_role: "ORG_ADMIN"
--
-- and the function THROWS. Not "returns the wrong answer" — throws, on every
-- call, for every caller. Proven directly against prod this session:
--   SELECT count(*) FROM org_members WHERE role IN ('owner','admin','ORG_ADMIN');
--   ERROR: 22P02 invalid input value for enum org_member_role: "ORG_ADMIN"
--
-- Affected: allocate_credits_to_sub_org, get_parent_credit_rollup,
-- suspend_suborg, unsuspend_suborg — the entire sub-org credit and suspension
-- surface. They were never merely unreachable (0430/0431); they are broken.
-- The 0430/0431 overloads reproduce the prod bodies verbatim, which was the
-- right call for identity semantics and means they inherited this too. All
-- eight signatures are repaired here.
--
-- HOW IT SURVIVED THREE ROUNDS OF PROOF
--   The throwaway-cluster fixtures declared `org_members.role` as `text`. Text
--   compares to text without coercion, so the predicate passed and 0430/0431
--   went green — 27/27 and 22/22 — against a schema that differed from prod in
--   exactly the way that mattered. The isolated soak rig, which replays the
--   REAL schema, failed on the first driver cycle. The fixture has since been
--   corrected to declare the real enum so this class cannot hide again.
--
--   That is the argument for soaking on a real rig rather than trusting a
--   hand-built fixture, and it is worth more than this migration.
--
-- THE FIX: `role::text IN (...)`, not a shortened list.
--   Casting preserves the evident intent — tolerate a legacy/profile-level
--   ORG_ADMIN — without asking Postgres to coerce a non-label. Adding
--   'ORG_ADMIN' to the enum was rejected: it would introduce an assignable role
--   that means nothing, to make a wrong predicate accidentally legal.
--
-- ALSO AFFECTED, DELIBERATELY NOT TOUCHED HERE
--   `update_profile_onboarding` carries the same predicate. It is outside this
--   epic and has a different blast radius (account onboarding), so it is logged
--   separately rather than folded into a sub-org migration.
--
-- Every body below is the CURRENT definition with ONLY the predicate changed —
-- generated mechanically from the deployed sources rather than retyped, so no
-- transcription can drift. The suspend/unsuspend bodies are 0431's corrected
-- audit versions, never the pre-0431 ones.
--
-- ROLLBACK:
--   Reverting restores functions that throw 22P02 on every call. There is no
--   state to undo — re-apply the prior definitions from 0430/0431 (and, for the
--   two base credit signatures, the pre-0430 prod bodies) only if this
--   migration itself is defective.
-- =============================================================================

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
  ) THEN
    RETURN jsonb_build_object('error', 'parent_admin_required');
  END IF;

  SELECT parent_org_id INTO v_actual_parent FROM organizations WHERE id = p_child_org_id;
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

CREATE OR REPLACE FUNCTION public.get_parent_credit_rollup(
  p_parent_org_id uuid,
  p_caller_user_id uuid
) RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := p_caller_user_id;   -- 0430: was auth.uid()
  v_parent_balance integer;
  v_children jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('error', 'authentication_required');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = v_caller AND org_id = p_parent_org_id
      AND role::text IN ('owner', 'admin', 'ORG_ADMIN')
  ) THEN
    RETURN jsonb_build_object('error', 'parent_admin_required');
  END IF;

  SELECT balance INTO v_parent_balance FROM org_credits WHERE org_id = p_parent_org_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'child_org_id', o.id,
    'balance', coalesce(c.balance, 0),
    'monthly_allocation', coalesce(c.monthly_allocation, 0)
  )), '[]'::jsonb) INTO v_children
  FROM organizations o
  LEFT JOIN org_credits c ON c.org_id = o.id
  WHERE o.parent_org_id = p_parent_org_id;

  RETURN jsonb_build_object(
    'parent_org_id', p_parent_org_id,
    'parent_balance', coalesce(v_parent_balance, 0),
    'children', v_children
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
    FROM organizations WHERE id = p_sub_org_id;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_child_of_parent');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = v_caller AND org_id = p_parent_org_id
      AND role::text IN ('owner', 'admin', 'ORG_ADMIN')
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
    FROM organizations WHERE id = p_sub_org_id;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_child_of_parent');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = v_caller AND org_id = p_parent_org_id
      AND role::text IN ('owner', 'admin', 'ORG_ADMIN')
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
    FROM organizations WHERE id = p_sub_org_id;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_child_of_parent');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = v_caller AND org_id = p_parent_org_id
      AND role::text IN ('owner', 'admin', 'ORG_ADMIN')
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
    FROM organizations WHERE id = p_sub_org_id;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_child_of_parent');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = v_caller AND org_id = p_parent_org_id
      AND role::text IN ('owner', 'admin', 'ORG_ADMIN')
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
  ) THEN
    RETURN jsonb_build_object('error', 'parent_admin_required');
  END IF;
  SELECT parent_org_id INTO v_actual_parent FROM organizations WHERE id = p_child_org_id;
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

CREATE OR REPLACE FUNCTION public.get_parent_credit_rollup(p_parent_org_id uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_parent_balance integer;
  v_children jsonb;
BEGIN
  IF v_caller IS NULL THEN RETURN jsonb_build_object('error', 'authentication_required'); END IF;
  IF NOT EXISTS (
    SELECT 1 FROM org_members WHERE user_id = v_caller AND org_id = p_parent_org_id
      AND role::text IN ('owner', 'admin', 'ORG_ADMIN')
  ) THEN
    RETURN jsonb_build_object('error', 'parent_admin_required');
  END IF;
  SELECT balance INTO v_parent_balance FROM org_credits WHERE org_id = p_parent_org_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'child_org_id', o.id, 'balance', coalesce(c.balance, 0),
    'monthly_allocation', coalesce(c.monthly_allocation, 0)
  )), '[]'::jsonb) INTO v_children
  FROM organizations o LEFT JOIN org_credits c ON c.org_id = o.id
  WHERE o.parent_org_id = p_parent_org_id;
  RETURN jsonb_build_object('parent_org_id', p_parent_org_id,
    'parent_balance', coalesce(v_parent_balance, 0), 'children', v_children);
END;
$function$;

COMMIT;
