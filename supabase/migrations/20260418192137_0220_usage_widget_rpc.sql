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

NOTIFY pgrst, 'reload schema';;
