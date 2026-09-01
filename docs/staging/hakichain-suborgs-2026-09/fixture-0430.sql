-- Fixture extension for 0430. Loaded AFTER fixture-0429.sql.
-- The two original RPC bodies are the LIVE PROD definitions captured this
-- session via pg_get_functiondef, so the overload proof runs against the real
-- pre-0430 shape rather than an approximation.

CREATE TABLE public.org_credit_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_org_id uuid NOT NULL REFERENCES public.organizations(id),
  child_org_id uuid NOT NULL REFERENCES public.organizations(id),
  amount integer NOT NULL,
  granted_by uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  event_category text,
  actor_id uuid,
  target_type text,
  target_id text,
  org_id uuid,
  details text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Original (pre-0430) 4-arg overload, verbatim from prod ───────────────────
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
    WHERE user_id = v_caller AND org_id = p_parent_org_id AND role IN ('owner', 'admin', 'ORG_ADMIN')
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
      AND role IN ('owner', 'admin', 'ORG_ADMIN')
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
