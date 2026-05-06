-- SCRUM-1170-A — Parent/Sub-Org credit allocation foundation.
--
-- Per the design doc at https://arkova.atlassian.net/wiki/spaces/A/pages/29458434,
-- HakiChain needs per-org credit balances + parent → sub-org allocation. The
-- existing `credits` table (migration 0053) is per-USER, so we add an org-level
-- counterpart without touching the user-credit code path.
--
-- This migration ships ONLY the schema + helper RPCs. No worker changes, no
-- enforcement at anchor submit (gated under SCRUM-1170-B in a follow-up).
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS allocate_credits_to_sub_org(uuid, uuid, integer, text);
--   DROP FUNCTION IF EXISTS get_org_credit_summary(uuid);
--   DROP FUNCTION IF EXISTS get_parent_credit_rollup(uuid);
--   DROP FUNCTION IF EXISTS deduct_org_credit(uuid, integer, text, uuid);
--   DROP TABLE IF EXISTS org_credit_allocations;
--   DROP TABLE IF EXISTS org_credits;

BEGIN;

-- ─── 1. Per-org credit balance ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_credits (
  org_id              uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  balance             integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
  monthly_allocation  integer NOT NULL DEFAULT 0 CHECK (monthly_allocation >= 0),
  purchased           integer NOT NULL DEFAULT 0 CHECK (purchased >= 0),
  cycle_start         timestamptz NOT NULL DEFAULT date_trunc('month', now()),
  cycle_end           timestamptz NOT NULL DEFAULT date_trunc('month', now()) + interval '1 month',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE org_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_credits FORCE ROW LEVEL SECURITY;

-- Org members can read their org's balance.
DROP POLICY IF EXISTS org_credits_select ON org_credits;
CREATE POLICY org_credits_select ON org_credits
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.org_id = org_credits.org_id AND om.user_id = (SELECT auth.uid())
    )
  );

-- Service role does all writes (allocation + deduction RPCs run as SECURITY DEFINER).
-- No INSERT/UPDATE/DELETE policy for authenticated → implicit deny.

-- ─── 2. Allocation audit log ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_credit_allocations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  child_org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  amount              integer NOT NULL,    -- can be negative for revocation
  effective_at        timestamptz NOT NULL DEFAULT now(),
  granted_by          uuid NOT NULL REFERENCES auth.users(id),
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT one_level_only CHECK (parent_org_id <> child_org_id)
);

CREATE INDEX IF NOT EXISTS idx_org_credit_allocations_parent
  ON org_credit_allocations (parent_org_id, effective_at DESC);
CREATE INDEX IF NOT EXISTS idx_org_credit_allocations_child
  ON org_credit_allocations (child_org_id, effective_at DESC);

ALTER TABLE org_credit_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_credit_allocations FORCE ROW LEVEL SECURITY;

-- Members of either parent or child org can read the allocation row.
DROP POLICY IF EXISTS org_credit_allocations_select ON org_credit_allocations;
CREATE POLICY org_credit_allocations_select ON org_credit_allocations
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.user_id = (SELECT auth.uid())
        AND (om.org_id = org_credit_allocations.parent_org_id
          OR om.org_id = org_credit_allocations.child_org_id)
    )
  );

-- ─── 3. RPC: allocate credits parent → sub-org (atomic) ────────────
CREATE OR REPLACE FUNCTION allocate_credits_to_sub_org(
  p_parent_org_id uuid,
  p_child_org_id  uuid,
  p_amount        integer,
  p_note          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller         uuid := auth.uid();
  v_parent_balance integer;
  v_child_balance  integer;
  v_actual_parent  uuid;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('error', 'authentication_required');
  END IF;

  -- Caller must be admin of the parent org.
  IF NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = v_caller AND org_id = p_parent_org_id AND role IN ('owner', 'admin', 'ORG_ADMIN')
  ) THEN
    RETURN jsonb_build_object('error', 'parent_admin_required');
  END IF;

  -- Verify the child is actually a sub-org of the parent.
  SELECT parent_org_id INTO v_actual_parent FROM organizations WHERE id = p_child_org_id;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('error', 'not_a_sub_org');
  END IF;

  -- Lock both rows in a deterministic order to avoid deadlock.
  PERFORM 1 FROM org_credits WHERE org_id = LEAST(p_parent_org_id, p_child_org_id) FOR UPDATE;
  PERFORM 1 FROM org_credits WHERE org_id = GREATEST(p_parent_org_id, p_child_org_id) FOR UPDATE;

  -- Ensure rows exist (lazy init).
  INSERT INTO org_credits (org_id) VALUES (p_parent_org_id) ON CONFLICT (org_id) DO NOTHING;
  INSERT INTO org_credits (org_id) VALUES (p_child_org_id)  ON CONFLICT (org_id) DO NOTHING;

  SELECT balance INTO v_parent_balance FROM org_credits WHERE org_id = p_parent_org_id FOR UPDATE;

  -- Positive allocation requires the parent to have enough balance.
  IF p_amount > 0 AND v_parent_balance < p_amount THEN
    RETURN jsonb_build_object(
      'error', 'insufficient_parent_balance',
      'parent_balance', v_parent_balance,
      'requested', p_amount
    );
  END IF;

  -- Negative allocation (revocation) requires the child to have enough balance.
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

  -- Audit event (write through the worker-only audit_events table; service_role context allows it).
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
$$;

REVOKE ALL ON FUNCTION allocate_credits_to_sub_org(uuid, uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION allocate_credits_to_sub_org(uuid, uuid, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION allocate_credits_to_sub_org(uuid, uuid, integer, text) TO service_role;

-- ─── 4. RPC: get summary for an org (member-only) ──────────────────
CREATE OR REPLACE FUNCTION get_org_credit_summary(p_org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_row    org_credits%ROWTYPE;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('error', 'authentication_required');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = v_caller AND org_id = p_org_id
  ) THEN
    RETURN jsonb_build_object('error', 'not_a_member');
  END IF;

  SELECT * INTO v_row FROM org_credits WHERE org_id = p_org_id;
  IF v_row.org_id IS NULL THEN
    RETURN jsonb_build_object(
      'org_id', p_org_id,
      'balance', 0, 'monthly_allocation', 0, 'purchased', 0,
      'cycle_start', null, 'cycle_end', null, 'initialized', false
    );
  END IF;

  RETURN jsonb_build_object(
    'org_id', v_row.org_id,
    'balance', v_row.balance,
    'monthly_allocation', v_row.monthly_allocation,
    'purchased', v_row.purchased,
    'cycle_start', v_row.cycle_start,
    'cycle_end', v_row.cycle_end,
    'initialized', true
  );
END;
$$;

REVOKE ALL ON FUNCTION get_org_credit_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_org_credit_summary(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_org_credit_summary(uuid) TO service_role;

-- ─── 5. RPC: parent rollup (parent admin only) ──────────────────────
CREATE OR REPLACE FUNCTION get_parent_credit_rollup(p_parent_org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_parent_balance integer;
  v_children jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('error', 'authentication_required');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = v_caller AND org_id = p_parent_org_id
      AND role IN ('owner', 'admin', 'ORG_ADMIN')
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
$$;

REVOKE ALL ON FUNCTION get_parent_credit_rollup(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_parent_credit_rollup(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_parent_credit_rollup(uuid) TO service_role;

-- ─── 6. RPC: deduct credit (worker / service_role only) ────────────
CREATE OR REPLACE FUNCTION deduct_org_credit(
  p_org_id       uuid,
  p_amount       integer,
  p_reason       text DEFAULT 'anchor.create',
  p_reference_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance integer;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('error', 'invalid_amount');
  END IF;

  SELECT balance INTO v_balance FROM org_credits WHERE org_id = p_org_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('error', 'org_not_initialized', 'success', false);
  END IF;
  IF v_balance < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'insufficient_credits',
      'balance', v_balance,
      'required', p_amount
    );
  END IF;

  UPDATE org_credits SET balance = balance - p_amount, updated_at = now() WHERE org_id = p_org_id;

  RETURN jsonb_build_object(
    'success', true,
    'balance', v_balance - p_amount,
    'deducted', p_amount,
    'reason', p_reason,
    'reference_id', p_reference_id
  );
END;
$$;

REVOKE ALL ON FUNCTION deduct_org_credit(uuid, integer, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION deduct_org_credit(uuid, integer, text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
