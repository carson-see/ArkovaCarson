-- 0434_unified_credits_rollover_row_lock.sql
-- PR #2442: serialize the balance snapshot with rollover/debit writers.
-- Without this lock, a check can read last month's row, wait behind a
-- concurrent rollover/debit, then reset that committed debit to zero.
-- Signature, entitlement policy and deterministic row selection are unchanged.
-- ROLLBACK: restore only check_unified_credits from migration 0420, then
-- reassert the grants below and reload PostgREST. No data rewrite is needed.
-- That rollback reopens the verified lost-debit race; pause credit requests
-- during rollback and reapply before resuming them.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.check_unified_credits(p_org_id uuid DEFAULT NULL::uuid, p_user_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(monthly_allocation integer, used_this_month integer, remaining integer, has_credits boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_record unified_credits%ROWTYPE;
  v_carry_over integer;
BEGIN
  SELECT * INTO v_record FROM unified_credits uc
  WHERE (p_org_id IS NOT NULL AND uc.org_id = p_org_id)
     OR (p_user_id IS NOT NULL AND uc.user_id = p_user_id)
  ORDER BY (p_org_id IS NOT NULL AND uc.org_id = p_org_id) DESC NULLS LAST,
           uc.created_at,
           uc.id
  LIMIT 1
  FOR UPDATE;

  -- FAIL CLOSED (SCRUM-2538). No balance row means no entitlement, not 50
  -- credits. Callers must treat has_credits=false as "not authorized".
  IF NOT FOUND THEN
    RETURN QUERY SELECT 0, 0, 0, false;
    RETURN;
  END IF;

  IF v_record.billing_cycle_start < date_trunc('month', now()) THEN
    v_carry_over := LEAST(v_record.monthly_allocation - v_record.used_this_month, 50);

    UPDATE unified_credits
    SET used_this_month = 0,
        carry_over = v_carry_over,
        billing_cycle_start = date_trunc('month', now()),
        updated_at = now()
    WHERE id = v_record.id;

    v_record.used_this_month := 0;
    v_record.carry_over := v_carry_over;
  END IF;

  RETURN QUERY SELECT
    v_record.monthly_allocation,
    v_record.used_this_month,
    (v_record.monthly_allocation + v_record.carry_over - v_record.used_this_month)::integer,
    (v_record.used_this_month < v_record.monthly_allocation + v_record.carry_over);
END;
$$;

ALTER FUNCTION public.check_unified_credits(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.check_unified_credits(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_unified_credits(uuid, uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
