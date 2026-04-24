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

NOTIFY pgrst, 'reload schema';;
