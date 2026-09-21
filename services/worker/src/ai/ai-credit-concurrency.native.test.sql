-- Native PostgreSQL regression contract for migration 0467.
-- Run only in a disposable database after applying through 0467.
-- The harness must create one test organization, call ensure_ai_credits_period
-- concurrently from two independent sessions, and assert the following query
-- returns one row. It then calls deduct_ai_credits concurrently with allocation=1
-- and asserts exactly one true result and used_this_month=1.
-- This file states the database assertions; the release driver supplies sessions.
SELECT set_config('arkova_test.org_id', :'test_org_id', false);
SELECT set_config('arkova_test.now', :'test_now', false);
SELECT set_config('arkova_test.expect_debit', :'expect_debit', false);
DO $$
DECLARE v_rows integer; v_used integer;
BEGIN
  SELECT count(*), max(used_this_month)
  INTO v_rows, v_used
  FROM public.ai_credits
  WHERE org_id = current_setting('arkova_test.org_id')::uuid
    AND period_start <= current_setting('arkova_test.now')::timestamptz
    AND period_end > current_setting('arkova_test.now')::timestamptz;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'expected one covering row, got %', v_rows;
  END IF;
  IF current_setting('arkova_test.expect_debit')::boolean AND v_used <> 1 THEN
    RAISE EXCEPTION 'expected used_this_month=1, got %', v_used;
  END IF;
  IF has_function_privilege('anon', 'public.ensure_ai_credits_period(uuid,integer,timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ensure_ai_credits_period(uuid,integer,timestamptz)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.deduct_ai_credits(uuid,uuid,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.deduct_ai_credits(uuid,uuid,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.check_ai_credits(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.check_ai_credits(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'AI credit RPC ACL widened';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.ensure_ai_credits_period(uuid,integer,timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.deduct_ai_credits(uuid,uuid,integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.check_ai_credits(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost AI credit RPC access';
  END IF;
END $$;
