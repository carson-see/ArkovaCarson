-- 0349_scrum2349_credit_conservation_invariant_fix.sql
-- SCRUM-2349 (PM-25 / S1-9) — money-conservation reconciler correctness fix.
--
-- WHAT THIS FIXES
-- ---------------
-- The reconciliation function `org_credit_ledger_divergence` (added by 0341)
-- compared `org_credits.balance` against a `p_initial_grant` SCALAR that
-- defaults to 0. But credit GRANTS are NOT ledger rows — the foundation
-- migration only ever inserts DEBIT/REFUND rows into `org_credit_deductions`;
-- grants land directly in the `org_credits` columns (`purchased`,
-- `monthly_allocation`) plus net parent→child sub-org transfers in
-- `org_credit_allocations`. So the S1-9 daily caller (which invokes the function
-- arg-less → p_initial_grant DEFAULT 0) computes expected = 0 + Σ(ledger) for
-- every org, and any funded org with balance > 0 and an empty ledger
-- false-flags `diverged = true`. The first daily tick would page an error-level
-- "Credit conservation VIOLATED" for healthy orgs (cry-wolf), and because
-- expected == 0 makes divergence == balance, the alert would also leak the org's
-- exact balance (PII, §1.4).
--
-- Prod confirmation (project vzwyaatejekddvltxyye, 2026-06-27, read-only):
-- the LIVE 0341 function flags 3 of 5 orgs (balance 50/10/5, ledger empty,
-- expected 0). The corrected expression below flags 0 of 5. (org_credit_allocations
-- has 0 rows today, so the net term is 0 in prod — but it is part of the true
-- grant and is included for correctness once sub-org transfers exist.)
--
-- THE FIX
-- -------
-- Drop the scalar arg and source each org's true expected credits from the real
-- columns: expected = purchased + monthly_allocation + net(org_credit_allocations)
-- + SUM(org_credit_deductions.amount). The new `granted` column surfaces the
-- grant total. allocate_credits_to_sub_org does parent.balance -= amount;
-- child.balance += amount; INSERT org_credit_allocations — so a child is boosted
-- by SUM(amount received) and a parent reduced by SUM(amount given); the
-- net-allocations term (received − given) is the allocation contribution to the
-- grant.
--
-- Numbering: 0344 in the original PR; renumbered to 0347 on 2026-06-27 base
-- refresh, then to 0349 on 2026-06-28 base refresh — prod ledger advanced to
-- 0348 (0347 = lane1_i4_chain_block_hash_reorg, 0348 = scrum2353_webhook_event_claims),
-- so the original 0347 slot collided. Next free prefix is 0349 (max(prod head
-- 0348)+1).
-- Signature change (uuid, integer) → (uuid) is a CREATE-after-DROP, not an
-- overload — the old two-arg function is dropped first so no DEFAULT-overload
-- ambiguity remains.

BEGIN;

-- Drop the old (uuid, integer) signature so the arg-shape change is clean (a
-- bare CREATE OR REPLACE cannot change the argument list).
DROP FUNCTION IF EXISTS public.org_credit_ledger_divergence(uuid, integer);

CREATE OR REPLACE FUNCTION public.org_credit_ledger_divergence(
  p_org_id uuid DEFAULT NULL
)
RETURNS TABLE (
  org_id uuid,
  balance integer,
  granted bigint,
  ledger_sum bigint,
  expected bigint,
  divergence bigint,
  diverged boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    oc.org_id,
    oc.balance,
    (oc.purchased + oc.monthly_allocation + COALESCE(alloc.net, 0))::bigint AS granted,
    COALESCE(led.ledger_sum, 0)::bigint AS ledger_sum,
    (oc.purchased + oc.monthly_allocation + COALESCE(alloc.net, 0) + COALESCE(led.ledger_sum, 0))::bigint AS expected,
    (oc.balance
       - (oc.purchased + oc.monthly_allocation + COALESCE(alloc.net, 0) + COALESCE(led.ledger_sum, 0)))::bigint AS divergence,
    oc.balance
      <> (oc.purchased + oc.monthly_allocation + COALESCE(alloc.net, 0) + COALESCE(led.ledger_sum, 0)) AS diverged
  FROM org_credits oc
  LEFT JOIN (
    SELECT d.org_id, SUM(d.amount)::bigint AS ledger_sum
    FROM org_credit_deductions d
    GROUP BY d.org_id
  ) led ON led.org_id = oc.org_id
  LEFT JOIN (
    SELECT oc2.org_id, COALESCE(recv.amt, 0) - COALESCE(given.amt, 0) AS net
    FROM org_credits oc2
    LEFT JOIN (
      SELECT child_org_id AS org_id, SUM(amount) AS amt
      FROM org_credit_allocations GROUP BY child_org_id
    ) recv ON recv.org_id = oc2.org_id
    LEFT JOIN (
      SELECT parent_org_id AS org_id, SUM(amount) AS amt
      FROM org_credit_allocations GROUP BY parent_org_id
    ) given ON given.org_id = oc2.org_id
  ) alloc ON alloc.org_id = oc.org_id
  WHERE p_org_id IS NULL OR oc.org_id = p_org_id;
$$;

REVOKE ALL ON FUNCTION public.org_credit_ledger_divergence(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.org_credit_ledger_divergence(uuid) TO service_role;

COMMENT ON FUNCTION public.org_credit_ledger_divergence(uuid) IS
  'SCRUM-2349 (0349 fix, supersedes 0341 body): money-conservation reconciliation. '
  'expected = org_credits.purchased + monthly_allocation + net(org_credit_allocations) '
  '+ SUM(org_credit_deductions.amount). Grants live in org_credits, NOT the ledger '
  '(the 0341 p_initial_grant=0 scalar false-flagged every funded org). Daily sweeper '
  'queries WHERE diverged; service_role EXECUTE only.';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ROLLBACK:
-- Restores the exact 0341 (uuid, integer) body (p_initial_grant scalar, no
-- `granted` column). NOTE: rolling back re-introduces the cry-wolf false-flag
-- behaviour — only roll back if the S1-9 daily caller is also disabled.
-- BEGIN;
--   DROP FUNCTION IF EXISTS public.org_credit_ledger_divergence(uuid);
--   CREATE OR REPLACE FUNCTION public.org_credit_ledger_divergence(
--     p_org_id uuid DEFAULT NULL,
--     p_initial_grant integer DEFAULT 0
--   )
--   RETURNS TABLE (
--     org_id uuid,
--     balance integer,
--     ledger_sum bigint,
--     expected integer,
--     divergence bigint,
--     diverged boolean
--   )
--   LANGUAGE sql
--   STABLE
--   SECURITY DEFINER
--   SET search_path = public
--   AS $$
--     SELECT
--       oc.org_id,
--       oc.balance,
--       COALESCE(led.ledger_sum, 0) AS ledger_sum,
--       (p_initial_grant + COALESCE(led.ledger_sum, 0))::integer AS expected,
--       (oc.balance - (p_initial_grant + COALESCE(led.ledger_sum, 0)))::bigint AS divergence,
--       oc.balance <> (p_initial_grant + COALESCE(led.ledger_sum, 0)) AS diverged
--     FROM org_credits oc
--     LEFT JOIN (
--       SELECT d.org_id, SUM(d.amount)::bigint AS ledger_sum
--       FROM org_credit_deductions d
--       GROUP BY d.org_id
--     ) led ON led.org_id = oc.org_id
--     WHERE p_org_id IS NULL OR oc.org_id = p_org_id;
--   $$;
--   REVOKE ALL ON FUNCTION public.org_credit_ledger_divergence(uuid, integer) FROM PUBLIC, anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.org_credit_ledger_divergence(uuid, integer) TO service_role;
--   NOTIFY pgrst, 'reload schema';
-- COMMIT;
