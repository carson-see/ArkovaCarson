-- Native PostgreSQL regression contract for migration 0467.
-- Run only in a disposable database after applying through 0467.
-- The harness must create one test organization, call ensure_ai_credits_period
-- concurrently from two independent sessions, and assert the following query
-- returns one row. It then calls deduct_ai_credits concurrently with allocation=1
-- and asserts exactly one true result and used_this_month=1.
-- This file states the database assertions; the release driver supplies sessions.
SELECT org_id, count(*) AS covering_rows
FROM public.ai_credits
WHERE org_id = :'test_org_id'::uuid
  AND period_start <= :'test_now'::timestamptz
  AND period_end > :'test_now'::timestamptz
GROUP BY org_id
HAVING count(*) = 1;
