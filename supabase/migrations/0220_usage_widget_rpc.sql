-- Migration 0220: Fast user monthly anchor count RPC (BUG-2026-04-19-001 follow-up)
--
-- BACKGROUND: The frontend UsageWidget (src/hooks/useEntitlements.ts)
-- counts this-month anchors for the current user. Through RLS on a 2.8M-row
-- `anchors` table, this query took 23s and 500'd at the 30s Supabase REST
-- timeout for platform admins / high-volume pipeline operators
-- (carson@arkova.ai has 757K anchors this month via the pipeline —
-- legitimate, but kills the widget).
--
-- Dashboard stat cards avoid this by calling `get_user_anchor_stats`
-- (SECURITY DEFINER, bypasses RLS, <100ms). The UsageWidget was the last
-- surface still using the slow RLS path.
--
-- PR #426 shipped a 5s AbortController fallback to stop the widget from
-- stranding on the loading skeleton. This migration adds the proper
-- fast-path RPC so the fallback never fires in practice.
--
-- Mirror of the existing `get_user_anchor_stats` pattern from migration 0176.
--
-- Jira: SCRUM-908 / BUG-2026-04-19-001 follow-up
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS get_user_monthly_anchor_count(uuid);

CREATE OR REPLACE FUNCTION get_user_monthly_anchor_count(p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::integer FROM anchors
  WHERE user_id = p_user_id
    AND created_at >= date_trunc('month', now());
$$;

COMMENT ON FUNCTION get_user_monthly_anchor_count IS
  'BUG-2026-04-19-001: Fast SECURITY DEFINER count of this-month anchors '
  'for a user. Bypasses RLS (which makes the equivalent client query take '
  '23s+ for platform admins). Callable by authenticated users for their '
  'own uid only — the client-side code must not pass a different uid.';

-- Authenticated users may call it but only for their own uid. Enforced
-- at the function level: if p_user_id != auth.uid(), return 0 to avoid
-- leaking counts for other users.
CREATE OR REPLACE FUNCTION get_user_monthly_anchor_count(p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_user_id = auth.uid() THEN (
      SELECT count(*)::integer FROM anchors
      WHERE user_id = p_user_id
        AND created_at >= date_trunc('month', now())
    )
    ELSE 0
  END;
$$;

REVOKE EXECUTE ON FUNCTION get_user_monthly_anchor_count(uuid) FROM public;
REVOKE EXECUTE ON FUNCTION get_user_monthly_anchor_count(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION get_user_monthly_anchor_count(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_user_monthly_anchor_count(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
