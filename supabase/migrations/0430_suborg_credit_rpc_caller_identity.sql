-- =============================================================================
-- 0430 — Sub-org credit RPCs: explicit caller identity (SCRUM-3865, epic SCRUM-3863)
--
-- Closes pre-mortem finding F3: the parent admin has no way to fund a sub-org.
-- `allocate_credits_to_sub_org` exists, is transactionally sound, and has ZERO
-- callers anywhere in the repository. `org_credit_allocations` has never had a
-- row in production.
--
-- WHY IT COULD NOT SIMPLY BE CALLED
--   Both sub-org credit RPCs resolve the caller with `auth.uid()` and return
--   `authentication_required` when it is NULL. The worker holds only a
--   service_role client (`services/worker/src/utils/db.ts` — there is no
--   user-scoped client anywhere in the worker), and `auth.uid()` is NULL under
--   service_role. So a worker endpoint calling either RPC would fail 100% of
--   the time. Meanwhile 0378 revoked both from `authenticated`, so the browser
--   cannot call them either. The RPCs were unreachable from every client that
--   exists. This is the SCRUM-2213 defect class that migration 0367 already
--   fixed for `supersede_anchor` / `resolve_anchor_queue_by_public_id`.
--
-- FIX (0367 precedent, applied verbatim)
--   Add ONE new overload of each function taking an explicit
--   `p_caller_user_id uuid`, REQUIRED with no default so PostgREST can never
--   resolve an existing call shape to the new overload and there is no
--   signature ambiguity. Each new body is IDENTICAL to the live production body
--   (captured this session via `pg_get_functiondef` on `vzwyaatejekddvltxyye`,
--   not copied from an older migration file) except that every `auth.uid()`
--   reference becomes `p_caller_user_id`. Every authorization check is
--   preserved verbatim: the caller must still be an owner/admin/ORG_ADMIN of
--   the parent org, and the child must still actually be a sub-org of that
--   parent. The audit row and the allocation ledger row still record the real
--   human actor rather than a service principal.
--
--   The original overloads are left completely untouched — zero behaviour
--   change for any real-session caller.
--
-- SECURITY (§1.4) — the grant posture is load-bearing
--   The new overloads are granted to `service_role` ONLY. If `authenticated`
--   could reach an identity-carrying overload through PostgREST, any signed-in
--   user could pass an arbitrary `p_caller_user_id` and move credits as another
--   org's admin — a privilege escalation. Only the worker, which has already
--   verified the JWT before constructing the call and never takes the caller id
--   from the request body, can reach this path.
--
-- CONCURRENCY NOTE (observed, deliberately NOT changed)
--   The allocation body takes ordered locks via LEAST/GREATEST BEFORE the
--   `INSERT ... ON CONFLICT DO NOTHING` that lazily creates the org_credits
--   rows, so on a first-ever allocation those pre-locks match no row. In
--   practice both rows already exist — `initializeAffiliateCredits` seeds the
--   child at creation and the parent is long-established — so the ordering is
--   effective. Preserving the body verbatim is the 0367 contract; this is
--   recorded as an observation rather than silently "fixed" inside a migration
--   whose stated purpose is an identity change.
--
-- ROLLBACK:
--   The original overloads are untouched, so dropping the new ones fully
--   reverts this migration. Executable as written:
--
--   BEGIN;
--   DROP FUNCTION IF EXISTS public.allocate_credits_to_sub_org(uuid, uuid, integer, text, uuid);
--   DROP FUNCTION IF EXISTS public.get_parent_credit_rollup(uuid, uuid);
--   COMMIT;
--
--   NOTE: rolling back re-breaks the only path by which a parent admin can fund
--   a sub-org (F3). The worker endpoint in this PR calls the 5-arg / 2-arg
--   forms, so roll the worker back in the same motion or it will 404 on the RPC.
-- =============================================================================

BEGIN;

-- ─── allocate_credits_to_sub_org: 5-arg overload with explicit caller ────────

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

ALTER FUNCTION public.allocate_credits_to_sub_org(uuid, uuid, integer, text, uuid) OWNER TO postgres;

COMMENT ON FUNCTION public.allocate_credits_to_sub_org(uuid, uuid, integer, text, uuid) IS
  'SCRUM-3865: worker-callable overload of allocate_credits_to_sub_org taking an explicit caller id, because auth.uid() is NULL under the worker service_role client (0367 precedent). service_role ONLY — reachable by authenticated would allow impersonating any parent-org admin.';

REVOKE ALL ON FUNCTION public.allocate_credits_to_sub_org(uuid, uuid, integer, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_credits_to_sub_org(uuid, uuid, integer, text, uuid) TO service_role;

-- ─── get_parent_credit_rollup: 2-arg overload with explicit caller ───────────
-- Backs the parent-facing spend view. Per decision D2 the parent sees balances
-- and spend for its sub-orgs, never their record contents.

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
$function$;

ALTER FUNCTION public.get_parent_credit_rollup(uuid, uuid) OWNER TO postgres;

COMMENT ON FUNCTION public.get_parent_credit_rollup(uuid, uuid) IS
  'SCRUM-3865: worker-callable overload of get_parent_credit_rollup taking an explicit caller id (0367 precedent). service_role ONLY. Returns per-sub-org balances only — never record contents (decision D2).';

REVOKE ALL ON FUNCTION public.get_parent_credit_rollup(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_parent_credit_rollup(uuid, uuid) TO service_role;

COMMIT;
