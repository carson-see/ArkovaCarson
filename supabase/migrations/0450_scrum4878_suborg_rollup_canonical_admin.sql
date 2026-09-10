-- SCRUM-4878 / PR #2572: credit rollup uses the same administrator authority
-- as the worker resolver and migration 0444: parent membership, own-org
-- ORG_ADMIN profile, or platform administrator. Both existing signatures and
-- response fields are retained. The auth.uid() overload delegates to one
-- implementation so the two authorization paths cannot drift again.
-- Both overloads remain service_role-only; the explicit caller is trusted
-- only because anon/authenticated cannot execute this RPC.
--
-- ROLLBACK: inside BEGIN / SET LOCAL lock_timeout = '5s' / COMMIT, restore ONLY
-- the two get_parent_credit_rollup definitions from immutable migration 0432
-- and their four REVOKE/GRANT statements; NOTIFY pgrst, 'reload schema'.
-- Do not reapply all of 0432: that would undo the separate 0444 write locks.
-- The focused regression driver verifies this literal rollback/reapplication.
-- No table shape, seed data, balance or function signature changes.

BEGIN;
SET LOCAL lock_timeout = '5s';

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
  v_caller uuid := p_caller_user_id;
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
  ) AND NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_caller AND (
      (org_id = p_parent_org_id AND role::text = 'ORG_ADMIN')
      OR is_platform_admin = true
    )
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

CREATE OR REPLACE FUNCTION public.get_parent_credit_rollup(p_parent_org_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.get_parent_credit_rollup(p_parent_org_id, (SELECT auth.uid()));
$function$;

REVOKE ALL ON FUNCTION public.get_parent_credit_rollup(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_parent_credit_rollup(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.get_parent_credit_rollup(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_parent_credit_rollup(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
