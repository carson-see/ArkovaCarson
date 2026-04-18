-- Migration 0220: Fast user monthly anchor count RPC (BUG-2026-04-19-001)
--
-- Counting this-month anchors through RLS on a 2.8M-row `anchors` table
-- took 23s and 500'd at the 30s Supabase REST timeout for platform admins
-- and high-volume pipeline operators. This RPC mirrors the
-- `get_user_anchor_stats` pattern (migration 0176): SECURITY DEFINER,
-- bypasses RLS, <100ms.
--
-- Isolation: RAISE EXCEPTION on uid mismatch matches the fail-loud style
-- of 0175_fix_pipeline_stats_timeout and related RPCs. A silent 0-return
-- would hide caller bugs. The client is expected to pass its own
-- `auth.uid()`, so a mismatch means the client constructed the wrong
-- argument — surface that.
--
-- Jira: SCRUM-908 / BUG-2026-04-19-001
--
-- ROLLBACK: DROP FUNCTION IF EXISTS get_user_monthly_anchor_count(uuid);

CREATE OR REPLACE FUNCTION get_user_monthly_anchor_count(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'unauthorized: p_user_id must match auth.uid()'
      USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::integer INTO v_count FROM anchors
  WHERE user_id = p_user_id
    AND created_at >= date_trunc('month', now());

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION get_user_monthly_anchor_count IS
  'BUG-2026-04-19-001: count of this-month anchors for the calling user. '
  'SECURITY DEFINER bypasses RLS. RAISES 42501 if p_user_id != auth.uid().';

REVOKE EXECUTE ON FUNCTION get_user_monthly_anchor_count(uuid) FROM public;
REVOKE EXECUTE ON FUNCTION get_user_monthly_anchor_count(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION get_user_monthly_anchor_count(uuid) TO authenticated;
-- service_role bypasses GRANT checks; no explicit grant needed.

NOTIFY pgrst, 'reload schema';
