-- 0344_scrum2349_credit_conservation_invariant_fix.sql
-- Fix org_credit_ledger_divergence (added 0341): grants live in org_credits
-- (purchased + monthly_allocation [+ net org_credit_allocations]), NOT the ledger,
-- so the p_initial_grant=0 scalar false-flagged every funded org. Source the grant
-- from the real columns instead.
--
-- org_credit_allocations EXISTS in prod (parent_org_id, child_org_id, amount):
-- allocate_credits_to_sub_org does parent.balance-=amount; child.balance+=amount;
-- INSERT org_credit_allocations. So a child is boosted by SUM(amount received) and
-- a parent reduced by SUM(amount given) → the net-allocations term (received-given)
-- is part of the real grant and is included below.
-- ROLLBACK: restore the 0341 (uuid, integer) signature/body from
--   0341_scrum2349_2350_credit_integrity_foundation.sql.
BEGIN;
DROP FUNCTION IF EXISTS public.org_credit_ledger_divergence(uuid, integer);
CREATE OR REPLACE FUNCTION public.org_credit_ledger_divergence(p_org_id uuid DEFAULT NULL)
RETURNS TABLE (org_id uuid, balance integer, granted bigint, ledger_sum bigint,
               expected bigint, divergence bigint, diverged boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT oc.org_id, oc.balance,
    (oc.purchased + oc.monthly_allocation + COALESCE(alloc.net,0))::bigint,
    COALESCE(led.ledger_sum,0)::bigint,
    (oc.purchased + oc.monthly_allocation + COALESCE(alloc.net,0) + COALESCE(led.ledger_sum,0))::bigint,
    (oc.balance - (oc.purchased + oc.monthly_allocation + COALESCE(alloc.net,0) + COALESCE(led.ledger_sum,0)))::bigint,
    oc.balance <> (oc.purchased + oc.monthly_allocation + COALESCE(alloc.net,0) + COALESCE(led.ledger_sum,0))
  FROM org_credits oc
  LEFT JOIN (SELECT d.org_id, SUM(d.amount)::bigint AS ledger_sum FROM org_credit_deductions d GROUP BY d.org_id) led ON led.org_id = oc.org_id
  LEFT JOIN (
    SELECT oc2.org_id, COALESCE(recv.amt,0) - COALESCE(given.amt,0) AS net
    FROM org_credits oc2
    LEFT JOIN (SELECT child_org_id AS org_id, SUM(amount) amt FROM org_credit_allocations GROUP BY child_org_id) recv ON recv.org_id = oc2.org_id
    LEFT JOIN (SELECT parent_org_id AS org_id, SUM(amount) amt FROM org_credit_allocations GROUP BY parent_org_id) given ON given.org_id = oc2.org_id
  ) alloc ON alloc.org_id = oc.org_id
  WHERE p_org_id IS NULL OR oc.org_id = p_org_id;
$$;
REVOKE ALL ON FUNCTION public.org_credit_ledger_divergence(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.org_credit_ledger_divergence(uuid) TO service_role;
COMMENT ON FUNCTION public.org_credit_ledger_divergence(uuid) IS 'SCRUM-2349 (0344 fix): expected = org_credits.purchased + monthly_allocation + net(org_credit_allocations) + SUM(org_credit_deductions.amount). Grants live in org_credits, not the ledger. Daily sweeper queries WHERE diverged.';
NOTIFY pgrst, 'reload schema';
COMMIT;
