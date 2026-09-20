-- 0468: serialize monthly credit expiry/allocation across Cloud Run instances.
-- Returns the existing integer 0 on a concurrent skip, preserving the RPC contract.
-- ROLLBACK: restore allocate_monthly_credits() from the baseline definition.
CREATE OR REPLACE FUNCTION public.allocate_monthly_credits() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_count integer := 0; v_record RECORD; v_plan_allocation integer; v_expired_monthly integer;
BEGIN
  IF auth.role() != 'service_role' THEN
    RAISE EXCEPTION 'Only service_role can allocate monthly credits' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT pg_try_advisory_xact_lock(8675309, 3) THEN RETURN 0; END IF;
  FOR v_record IN
    SELECT c.*, s.plan_id, p.name as plan_name FROM credits c
    LEFT JOIN subscriptions s ON s.user_id = c.user_id AND s.status IN ('active', 'trialing')
    LEFT JOIN plans p ON p.id = s.plan_id WHERE c.cycle_end <= now() FOR UPDATE OF c
  LOOP
    v_plan_allocation := CASE v_record.plan_name WHEN 'Individual' THEN 500 WHEN 'Professional' THEN 5000 ELSE 50 END;
    v_expired_monthly := GREATEST(0, v_record.balance - v_record.purchased);
    IF v_expired_monthly > 0 THEN
      INSERT INTO credit_transactions (user_id, transaction_type, amount, balance_after, reason)
      VALUES (v_record.user_id, 'EXPIRY', -v_expired_monthly, v_record.purchased, 'Monthly credits expired');
    END IF;
    UPDATE credits SET balance = v_record.purchased + v_plan_allocation,
      monthly_allocation = v_plan_allocation, cycle_start = date_trunc('month', now()),
      cycle_end = date_trunc('month', now()) + interval '1 month', updated_at = now()
    WHERE id = v_record.id;
    INSERT INTO credit_transactions (user_id, transaction_type, amount, balance_after, reason)
    VALUES (v_record.user_id, 'ALLOCATION', v_plan_allocation,
      v_record.purchased + v_plan_allocation, 'Monthly credit allocation');
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.allocate_monthly_credits() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_monthly_credits() TO service_role;
NOTIFY pgrst, 'reload schema';
