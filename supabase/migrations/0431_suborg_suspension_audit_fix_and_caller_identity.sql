-- =============================================================================
-- 0431 — Sub-org suspension: fix the dropped audit row, add caller identity
--        (SCRUM-3868, epic SCRUM-3863)
--
-- TWO PROBLEMS, ONE PAIR OF FUNCTIONS.
--
-- (1) A LIVE PRODUCTION DEFECT: every suspension silently loses its audit row.
--
--     `suspend_suborg` and `unsuspend_suborg` insert into
--     `audit_events (org_id, event_type, actor_user_id, payload)`. Those last
--     two columns DO NOT EXIST — the table has `actor_id` and `details`
--     (verified this session against vzwyaatejekddvltxyye). The insert is
--     wrapped in `BEGIN ... EXCEPTION WHEN OTHERS THEN RAISE NOTICE`, so it
--     throws on every call and is swallowed: the suspension succeeds and the
--     audit trail is lost. ORG-08 requires audit events on every transition.
--
--     This is EXACTLY the defect migration 0290 says it fixed in 2026-05-04,
--     and `0290` IS present in the prod ledger. The live function bodies are
--     nevertheless still the pre-0290 (0289) definitions — captured this
--     session via `pg_get_functiondef`, not read from a file. So the repo says
--     fixed and the database says otherwise. Whether 0290's row was recorded
--     without its content taking effect, or a later CREATE OR REPLACE reverted
--     it, the operative fact is the same and it is what this migration fixes.
--
--     This is the strongest possible argument for the rule that live bodies are
--     captured from prod rather than trusted from the migration history: a
--     compensating migration written from 0290's FILE would have concluded
--     there was nothing to fix.
--
--     The swallow itself is removed, not just the column names. A failure to
--     write the audit row must fail the transition: silently proceeding is what
--     hid this. With the correct columns the insert succeeds, so the practical
--     effect is an audit trail that now exists.
--
-- (2) Neither function is callable by the worker.
--
--     Both resolve the caller with `auth.uid()`, which is NULL under the
--     worker's service_role client, and both are service_role-only in prod — so
--     like the credit RPCs before 0430 they are reachable by no client that
--     exists. 0290's header claims to have added a `v_is_service` bypass; the
--     live bodies contain no such thing. Same fix as 0430 and 0367: ONE
--     identity-carrying overload each, `p_caller_user_id uuid` REQUIRED with no
--     default so PostgREST cannot resolve an existing call shape to it, body
--     otherwise identical with `auth.uid()` replaced. Every authorization check
--     is preserved verbatim.
--
-- SECURITY (§1.4)
--   The new overloads are `service_role` ONLY. Reachable by `authenticated`,
--   any signed-in user could pass an arbitrary `p_caller_user_id` and suspend
--   another partner's sub-org. The worker resolves the caller from the verified
--   session and never from the request body.
--
-- §1.2 HOT TABLE
--   These functions UPDATE `organizations`, a named hot table, but this
--   migration issues no DDL against it — only CREATE OR REPLACE FUNCTION. The
--   `SET LOCAL lock_timeout` below is belt-and-braces for the transaction.
--
-- ROLLBACK:
--   Reverting restores a silent audit-row loss on every suspension, so roll
--   back only for a functional defect. Executable as written:
--
--   BEGIN;
--   DROP FUNCTION IF EXISTS public.suspend_suborg(uuid, uuid, text, uuid);
--   DROP FUNCTION IF EXISTS public.unsuspend_suborg(uuid, uuid, uuid);
--   -- and restore the pre-0431 bodies of the 3-arg / 2-arg forms, which are
--   -- the 0289 definitions currently live in prod. They are reproduced in this
--   -- PR's description; they are NOT reproduced here because re-introducing a
--   -- known-broken audit insert from a copy-paste block is a footgun. If you
--   -- need them, `pg_get_functiondef` on any environment not yet carrying 0431
--   -- returns them verbatim.
--   COMMIT;
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ─── 1. suspend_suborg — corrected audit columns, no swallow ─────────────────

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
      AND role IN ('owner', 'admin', 'ORG_ADMIN')
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

ALTER FUNCTION public.suspend_suborg(uuid, uuid, text) OWNER TO postgres;

-- ─── 2. unsuspend_suborg — same correction ──────────────────────────────────

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

ALTER FUNCTION public.unsuspend_suborg(uuid, uuid) OWNER TO postgres;

-- ─── 3. Worker-callable overloads (0367 / 0430 pattern) ─────────────────────

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
      AND role IN ('owner', 'admin', 'ORG_ADMIN')
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

ALTER FUNCTION public.suspend_suborg(uuid, uuid, text, uuid) OWNER TO postgres;

COMMENT ON FUNCTION public.suspend_suborg(uuid, uuid, text, uuid) IS
  'SCRUM-3868: worker-callable overload taking an explicit caller id, because auth.uid() is NULL under the worker service_role client (0367/0430 precedent). service_role ONLY — reachable by authenticated it would let any signed-in user suspend another partner''s sub-org.';

REVOKE ALL ON FUNCTION public.suspend_suborg(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.suspend_suborg(uuid, uuid, text, uuid) TO service_role;

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

ALTER FUNCTION public.unsuspend_suborg(uuid, uuid, uuid) OWNER TO postgres;

COMMENT ON FUNCTION public.unsuspend_suborg(uuid, uuid, uuid) IS
  'SCRUM-3868: worker-callable overload taking an explicit caller id (0367/0430 precedent). service_role ONLY.';

REVOKE ALL ON FUNCTION public.unsuspend_suborg(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unsuspend_suborg(uuid, uuid, uuid) TO service_role;

COMMIT;
