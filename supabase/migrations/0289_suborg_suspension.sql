-- =============================================================================
-- Migration 0288: Sub-org suspension lifecycle (SCRUM-1652 ORG-HIER-02)
-- Story: SCRUM-1652 / ORG-08 from PRD 6 (Operational Launch Readiness 2026-05-01)
-- Date: 2026-05-04
--
-- PURPOSE
-- -------
-- ORG-07 delegation is already shipped: migration 0278 (SCRUM-1170-A) ships
-- `org_credits` + `org_credit_allocations` + `allocate_credits_to_sub_org()`
-- (atomic, parent_admin gated, audit-logged via the allocations table).
-- A negative-amount call to that same RPC handles revocation.
--
-- ORG-08 — suspension — is the missing piece. A parent admin must be able
-- to halt a sub-org's ability to anchor / run rules / accept integration
-- triggers without deleting any historical evidence. The invariants per
-- the May 1 PRD §PRD 6:
--
--   * Suspension is a flag, not a delete. Existing evidence remains
--     readable; consumed credits remain immutable in the ledger.
--   * Only the parent admin (or a platform admin) can suspend a sub-org.
--     Sub-org admins cannot self-suspend or suspend siblings.
--   * Audit events fire on every transition (org.suborg.suspended,
--     org.suborg.unsuspended) with actor / scope / reason.
--
-- This migration adds:
--
--   1. organizations.suspended boolean + suspended_at + suspended_by + suspended_reason
--   2. suspend_suborg(parent, sub, reason) RPC — parent_admin gated, audit-logged
--   3. unsuspend_suborg(parent, sub) RPC — same gate
--   4. is_org_suspended(org_id) helper for runtime enforcement (called by
--      worker handlers before dispatching anchor / queue / integration trigger)
--
-- Enforcement at the anchor / queue / integration-trigger code paths is a
-- worker change that lands in the same PR as a small guard helper. The
-- function below is the canonical SQL-level check.
--
-- ROLLBACK
-- --------
--   DROP FUNCTION IF EXISTS unsuspend_suborg(uuid, uuid);
--   DROP FUNCTION IF EXISTS suspend_suborg(uuid, uuid, text);
--   DROP FUNCTION IF EXISTS is_org_suspended(uuid);
--   ALTER TABLE organizations
--     DROP COLUMN IF EXISTS suspended,
--     DROP COLUMN IF EXISTS suspended_at,
--     DROP COLUMN IF EXISTS suspended_by,
--     DROP COLUMN IF EXISTS suspended_reason;
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- =============================================================================
-- 1. Suspension columns on organizations
-- =============================================================================

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS suspended boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS suspended_reason text;

CREATE INDEX IF NOT EXISTS idx_organizations_suspended
  ON organizations (suspended)
  WHERE suspended = true;

COMMENT ON COLUMN organizations.suspended IS
  'SCRUM-1652 ORG-08: when true, the org is barred from new anchors / queue runs / integration-trigger actions. Existing evidence remains readable. Only the org_credit_allocations ledger and audit_events table reflect ongoing financial/audit state during suspension.';

-- =============================================================================
-- 2. is_org_suspended() — runtime enforcement helper
-- =============================================================================

CREATE OR REPLACE FUNCTION is_org_suspended(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    (SELECT suspended FROM organizations WHERE id = p_org_id),
    false
  );
$$;

REVOKE ALL ON FUNCTION is_org_suspended(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_org_suspended(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION is_org_suspended(uuid) TO service_role;

COMMENT ON FUNCTION is_org_suspended(uuid) IS
  'SCRUM-1652: returns true if the given org_id is currently suspended. Worker-side guards call this before dispatching anchor / queue / integration-trigger actions.';

-- =============================================================================
-- 3. suspend_suborg() — parent_admin gated; emits audit event
-- =============================================================================

CREATE OR REPLACE FUNCTION suspend_suborg(
  p_parent_org_id uuid,
  p_sub_org_id    uuid,
  p_reason        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller        uuid := auth.uid();
  v_actual_parent uuid;
  v_already       boolean;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthenticated');
  END IF;

  -- Sub-org must be a child of the asserted parent. organizations.parent_org_id
  -- enforces single-level hierarchy via the ON DELETE RESTRICT FK.
  SELECT parent_org_id INTO v_actual_parent
    FROM organizations WHERE id = p_sub_org_id;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_child_of_parent');
  END IF;

  -- Caller must be an admin/owner of the parent org.
  IF NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = v_caller AND org_id = p_parent_org_id
      AND role IN ('owner', 'admin', 'ORG_ADMIN')
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'parent_admin_required');
  END IF;

  -- Idempotent re-suspend: bail without flipping the timestamp so audit
  -- events don't fire spuriously on UI double-clicks.
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

  -- Audit event row (best-effort — failure does not roll back the
  -- suspension itself, but emits a NOTICE the operator will see).
  BEGIN
    INSERT INTO audit_events (org_id, event_type, actor_user_id, payload)
    VALUES (
      p_parent_org_id,
      'org.suborg.suspended',
      v_caller,
      jsonb_build_object(
        'parent_org_id', p_parent_org_id,
        'sub_org_id',    p_sub_org_id,
        'reason',        p_reason,
        'at',            now()
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'suspend_suborg: audit_events insert failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'success',         true,
    'sub_org_id',      p_sub_org_id,
    'suspended_at',    now(),
    'suspended_by',    v_caller,
    'reason',          p_reason
  );
END;
$$;

REVOKE ALL ON FUNCTION suspend_suborg(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION suspend_suborg(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION suspend_suborg(uuid, uuid, text) TO service_role;

-- =============================================================================
-- 4. unsuspend_suborg() — symmetric to suspend
-- =============================================================================

CREATE OR REPLACE FUNCTION unsuspend_suborg(
  p_parent_org_id uuid,
  p_sub_org_id    uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
      AND role IN ('owner', 'admin', 'ORG_ADMIN')
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

  BEGIN
    INSERT INTO audit_events (org_id, event_type, actor_user_id, payload)
    VALUES (
      p_parent_org_id,
      'org.suborg.unsuspended',
      v_caller,
      jsonb_build_object(
        'parent_org_id', p_parent_org_id,
        'sub_org_id',    p_sub_org_id,
        'at',            now()
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'unsuspend_suborg: audit_events insert failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object('success', true, 'sub_org_id', p_sub_org_id, 'unsuspended_at', now());
END;
$$;

REVOKE ALL ON FUNCTION unsuspend_suborg(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unsuspend_suborg(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION unsuspend_suborg(uuid, uuid) TO service_role;

-- =============================================================================
-- 5. PostgREST schema cache reload
-- =============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
