-- =============================================================================
-- Migration 0290: Sub-org suspension RPC fix-ups (SCRUM-1652 follow-up)
-- Date: 2026-05-04
--
-- PURPOSE
-- -------
-- Compensating migration for two issues introduced by 0289 (immutable per
-- the constitution) and caught in the post-#689 review pass:
--
-- 1. AUDIT EVENTS COLUMN MISMATCH (silent data loss, severity: high).
--    The audit_events INSERT statements in 0289's `suspend_suborg()` and
--    `unsuspend_suborg()` referenced columns `actor_user_id` and `payload`
--    that do not exist in the `audit_events` schema. The real schema
--    (from migration 0006 + 0143 + 0170) is:
--      (event_type, event_category, actor_id, target_type, target_id,
--       org_id, details)
--    The wrapping `BEGIN ... EXCEPTION WHEN OTHERS RAISE NOTICE` swallowed
--    the failure, so the suspend/unsuspend call still succeeded but the
--    audit row was lost on every invocation. ORG-08 explicitly requires
--    "audit events fire on every transition" — this fixes that.
--
-- 2. SERVICE_ROLE BYPASS MISSING (dead-code GRANT, severity: medium).
--    `IF v_caller IS NULL THEN unauthenticated` blocked service_role
--    callers (auth.uid() returns NULL under service_role), which made
--    the `GRANT EXECUTE ... TO service_role` statements at the bottom of
--    0289 dead code. This migration adds a `v_is_service` check that
--    bypasses both the auth.uid gate and the parent-admin role check
--    when the caller is service_role / postgres or the JWT role claim
--    is service_role.
--
-- This migration was applied to prod on 2026-05-04 via Supabase MCP
-- before the file landed in the repo, due to PR #689 being squash-merged
-- before the second-round CodeRabbit follow-ups were ready. Committing
-- the file now closes the prod-vs-repo drift; re-applying via supabase
-- migration list is a no-op because both functions use `CREATE OR REPLACE`.
--
-- ROLLBACK
-- --------
--   Re-run the original 0289 bodies for both functions
--   (see supabase/migrations/0289_suborg_suspension.sql, lines 97-260).
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- =============================================================================
-- 1. suspend_suborg() — wrap auth.uid + accept service_role + correct audit
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
  v_caller        uuid := (SELECT auth.uid());
  v_is_service    boolean := (current_setting('request.jwt.claim.role', true) = 'service_role'
                              OR current_user IN ('service_role', 'postgres'));
  v_actual_parent uuid;
  v_already       boolean;
BEGIN
  -- service_role bypass: trusted server-side callers (worker, admin endpoints,
  -- migration backfills) skip the auth.uid + member-role gates. v_caller stays
  -- NULL in that case; audit_events will record actor_id=NULL.
  IF NOT v_is_service AND v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthenticated');
  END IF;

  -- Sub-org must be a child of the asserted parent. organizations.parent_org_id
  -- enforces single-level hierarchy via the ON DELETE RESTRICT FK.
  SELECT parent_org_id INTO v_actual_parent
    FROM organizations WHERE id = p_sub_org_id;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_child_of_parent');
  END IF;

  -- Caller must be a parent-org admin/owner OR a platform admin (per PRD §ORG-08).
  -- service_role bypasses the role gate (server-trusted call site).
  IF NOT v_is_service AND NOT (
    EXISTS (
      SELECT 1 FROM org_members
      WHERE user_id = v_caller AND org_id = p_parent_org_id
        AND role IN ('owner', 'admin', 'ORG_ADMIN')
    )
    OR EXISTS (
      SELECT 1 FROM profiles WHERE id = v_caller AND is_platform_admin = true
    )
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

  -- Audit row using the canonical audit_events schema (matches migration
  -- 0278's allocate_credits_to_sub_org pattern).
  BEGIN
    INSERT INTO audit_events (
      event_type, event_category, actor_id, target_type, target_id, org_id, details
    ) VALUES (
      'org.suborg.suspended', 'ORG', v_caller, 'organization', p_sub_org_id::text, p_parent_org_id,
      json_build_object(
        'parent_org_id', p_parent_org_id,
        'sub_org_id',    p_sub_org_id,
        'reason',        p_reason,
        'at',            now()
      )::text
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
-- 2. unsuspend_suborg() — same fix-ups
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
  v_caller        uuid := (SELECT auth.uid());
  v_is_service    boolean := (current_setting('request.jwt.claim.role', true) = 'service_role'
                              OR current_user IN ('service_role', 'postgres'));
  v_actual_parent uuid;
  v_currently     boolean;
BEGIN
  IF NOT v_is_service AND v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthenticated');
  END IF;

  SELECT parent_org_id INTO v_actual_parent
    FROM organizations WHERE id = p_sub_org_id;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_child_of_parent');
  END IF;

  IF NOT v_is_service AND NOT (
    EXISTS (
      SELECT 1 FROM org_members
      WHERE user_id = v_caller AND org_id = p_parent_org_id
        AND role IN ('owner', 'admin', 'ORG_ADMIN')
    )
    OR EXISTS (
      SELECT 1 FROM profiles WHERE id = v_caller AND is_platform_admin = true
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

  BEGIN
    INSERT INTO audit_events (
      event_type, event_category, actor_id, target_type, target_id, org_id, details
    ) VALUES (
      'org.suborg.unsuspended', 'ORG', v_caller, 'organization', p_sub_org_id::text, p_parent_org_id,
      json_build_object(
        'parent_org_id', p_parent_org_id,
        'sub_org_id',    p_sub_org_id,
        'at',            now()
      )::text
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
-- 3. PostgREST schema cache reload
-- =============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
