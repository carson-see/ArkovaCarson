-- 0485_scrum4939_refund_ai_credits_period_and_amount.sql
--
-- WHY THIS IS A THIRD FILE IN ONE PR. 0483 and 0484 are already committed, and
-- a migration file is IMMUTABLE once written (CLAUDE.md §1.2 / §4: "Never
-- modify an existing migration — write a compensating one"). The repo enforces
-- that with an edit hook, so the two independent-review findings below cannot
-- be folded back into 0484 even though they ship in the same PR and the same
-- T3 window. The split is useful on its own: 0484's function can be restored
-- by this file's ROLLBACK block without giving up 0483's lock_timeout
-- hardening, and each file's blast radius stays separately revertable.
--
-- THE TWO FINDINGS
--
-- S1 — THE RETURN VALUE CANNOT DISTINGUISH A REFUND FROM A NO-OP.
-- 0484 returns `boolean`, and it returns TRUE whenever a covering row was
-- UPDATEd — including when `GREATEST(used_this_month - p_amount, 0)` clamped
-- the decrement to nothing because the period had already been fully refunded
-- (a double refund from the reconciler, which legitimately retries and has no
-- idempotency key). The caller logs "AI credit refund reconciled" and the job
-- completes, having moved zero credit. The one outcome an operator most needs
-- to see — "this refund did nothing and the customer is still short" — is the
-- one that looked like success.
--   Now `RETURNS integer`: the number of credits ACTUALLY returned, 0..p_amount.
--     * 1..p_amount — that many credits came back.
--     * 0           — the floor clamped it; NOTHING moved. Distinct outcome.
--     * NULL        — no covering period row, or the arguments were invalid.
--                     Nothing was attempted. (0484 answered `false` for both
--                     of these AND for the clamp, which is the conflation.)
--
-- S2 — A REFUND AFTER MONTH ROLLOVER HITS THE WRONG PERIOD.
-- 0484 selects the period row with `period_start <= now() AND period_end > now()`
-- — the period the REFUND lands in, not the one the DEBIT was taken from. The
-- two differ whenever a refund crosses a period boundary, and that is not
-- exotic: `ai_credits.reconcile_refund` retries with exponential backoff and
-- the queue can be drained hours or days after the debit, so a debit taken at
-- 23:59 UTC on the last day of the month is refunded against the NEW month.
-- The old period stays overcharged forever (nothing else will ever decrement
-- it) and the new one is credited for consumption it never had — a silent
-- transfer of a customer's balance from one billing period into the next, in
-- both directions wrong.
--   Now the period is chosen by `coalesce(p_debited_at, now())`. Callers
--   capture `debited_at` at DEBIT time and pass it through all three refund
--   sites and the reconcile job payload, so a refund lands on the period its
--   debit was taken from. `p_debited_at` defaults to NULL, which reproduces
--   0484's `now()` behaviour exactly — required, because jobs enqueued before
--   this ships carry no `debitedAt` and must keep working.
--
-- WHY NOT AN OVERLOAD. `p_debited_at` has a DEFAULT, so keeping the 3-argument
-- signature alongside this one would be two functions differing only by a
-- defaulted trailing parameter — ambiguous to resolve and named in CLAUDE.md §6
-- ("Function overloads differing only by DEFAULT -> Single function with
-- DEFAULT"). The old signature is DROPped and replaced.
--
-- DEPLOY-WINDOW HAZARD, stated rather than discovered. PostgREST still resolves
-- a 3-named-argument call to this function (the 4th is defaulted), so a worker
-- revision predating this migration keeps working — but it reads the result as
-- `data === true`, and an integer is never `true`. In that window a refund
-- COMMITS and the old worker logs it as failed, then enqueues a reconciliation
-- that refunds again (bounded by the floor, and now visibly returning 0). Apply
-- this migration and deploy the worker together; if they must be ordered, the
-- worker first is the safe order, because the new worker handles BOTH shapes
-- (it treats a boolean `true` from 0484 as "refunded, amount unknown").
--
-- WHAT IS UNCHANGED FROM 0484, and why each line is still there
--   * service_role-only TWICE: the GRANT below and an in-body caller check,
--     because this function MINTS credit. The predicate stays 0466's idiom —
--     `coalesce(public.get_caller_role() = 'service_role', false)` — NOT a bare
--     `<> 'service_role'`: `get_caller_role()` returns NULL when request claims
--     are absent, and a NULL comparison makes a PL/pgSQL `IF` fall through,
--     i.e. fail OPEN.
--   * `p_amount` bounded at 1000, the same ceiling `MAX_RECONCILABLE_AMOUNT`
--     and `MAX_REFUNDABLE_AMOUNT` enforce in the worker.
--   * The SAME row predicate and `ORDER BY created_at,id LIMIT 1 FOR UPDATE` as
--     `deduct_ai_credits` (0467 lines 36-41), so a debit and a refund for one
--     org serialize against each other instead of interleaving on a stale read.
--     The ONLY difference is the instant the window is evaluated at.
--   * The floor. `LEAST(used_this_month, p_amount)` is the same arithmetic
--     0484's `GREATEST(used_this_month - p_amount, 0)` performs, written so the
--     amount actually moved is a value the function can return rather than a
--     side effect it discards. A refund still can never drive the period
--     negative and so can never mint credit beyond what the period consumed —
--     which remains the whole bound on a DOUBLE refund, since there is still no
--     idempotency key (the callers do not carry one; none is invented here).
--   * `SET lock_timeout='5s'`: behind a stuck holder it aborts with SQLSTATE
--     55P03 having refunded nothing, rather than pinning a worker request slot
--     until `statement_timeout`.
--
-- READ-ONLY PRECONDITION SELECTS for the operator, to run against prod BEFORE
-- applying (none of them write):
--   -- 1. 0484's function must be present in its known shape (boolean, 3 args):
--   SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
--          pg_get_function_result(p.oid) AS result, p.proconfig, p.prosecdef, p.proacl
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'refund_ai_credits';
--   -- 2. Nothing else may depend on the 3-argument signature (a view, a
--   --    trigger, another function body). Expect zero rows:
--   SELECT p.oid::regprocedure
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.oid <> 'public.refund_ai_credits(uuid,uuid,integer)'::regprocedure
--      AND pg_get_functiondef(p.oid) ILIKE '%refund_ai_credits%';
--   -- 3. Periods that a cross-boundary refund could already have hit. Rows
--   --    whose used_this_month exceeds what the period could have consumed are
--   --    the visible residue of S2; read-only, upper bound, not a ledger delta:
--   --      SELECT org_id, user_id, period_start, period_end,
--   --             used_this_month, monthly_allocation
--   --        FROM public.ai_credits
--   --       WHERE period_end <= now()
--   --         AND used_this_month > 0
--   --       ORDER BY period_end DESC;
--
-- ROLLBACK:
--   -- Restores 0484's function EXACTLY (boolean, 3 arguments, now()-scoped
--   -- period). Note what you are rolling back TO: a refund that cannot report
--   -- a clamped no-op, and that lands on the wrong period after a month
--   -- rollover. Revert the worker commits that read an integer result and pass
--   -- `p_debited_at` FIRST and redeploy, or the worker will send a 4th
--   -- argument this signature does not accept (PGRST202/42883 on every refund,
--   -- i.e. no refunds at all). Prefer fixing forward.
--   BEGIN;
--   SET LOCAL lock_timeout = '5s';
--   DROP FUNCTION IF EXISTS public.refund_ai_credits(uuid,uuid,integer,timestamptz);
--   CREATE OR REPLACE FUNCTION public.refund_ai_credits(p_org_id uuid DEFAULT NULL,p_user_id uuid DEFAULT NULL,p_amount integer DEFAULT 1)
--   RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
--   SET search_path='public' SET lock_timeout='5s' AS $rollback$
--   DECLARE v_id uuid; v_rows integer := 0;
--   BEGIN
--    IF NOT coalesce(public.get_caller_role() = 'service_role', false) THEN
--      RAISE EXCEPTION 'Only service_role can refund AI credits' USING ERRCODE='insufficient_privilege';
--    END IF;
--    IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 1000 OR (p_org_id IS NULL AND p_user_id IS NULL) THEN
--      RETURN false;
--    END IF;
--    SELECT id INTO v_id FROM public.ai_credits
--    WHERE ((p_org_id IS NOT NULL AND org_id=p_org_id) OR (p_user_id IS NOT NULL AND user_id=p_user_id))
--      AND period_start<=now() AND period_end>now()
--    ORDER BY created_at,id LIMIT 1 FOR UPDATE;
--    IF v_id IS NULL THEN RETURN false; END IF;
--    UPDATE public.ai_credits
--       SET used_this_month=GREATEST(used_this_month-p_amount,0),updated_at=now()
--     WHERE id=v_id;
--    GET DIAGNOSTICS v_rows = ROW_COUNT;
--    RETURN v_rows = 1;
--   END $rollback$;
--   REVOKE ALL ON FUNCTION public.refund_ai_credits(uuid,uuid,integer) FROM PUBLIC, anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.refund_ai_credits(uuid,uuid,integer) TO service_role;
--   NOTIFY pgrst, 'reload schema';
--   COMMIT;

BEGIN;

-- No hot-table DDL in this file (CLAUDE.md §1.2 names organizations/anchors/
-- profiles); the statement-level guard is kept anyway so a future edit cannot
-- inherit an unbounded lock queue.
SET LOCAL lock_timeout = '5s';

-- The signature CHANGES (integer result, 4th argument), so this is a DROP and
-- CREATE, not a CREATE OR REPLACE — which cannot change a return type and would
-- otherwise leave the 3-argument boolean function in place beside this one.
DROP FUNCTION public.refund_ai_credits(uuid,uuid,integer);

CREATE FUNCTION public.refund_ai_credits(p_org_id uuid DEFAULT NULL,p_user_id uuid DEFAULT NULL,p_amount integer DEFAULT 1,p_debited_at timestamptz DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path='public' SET lock_timeout='5s' AS $$
DECLARE v_id uuid; v_used integer; v_returned integer; v_at timestamptz;
BEGIN
 IF NOT coalesce(public.get_caller_role() = 'service_role', false) THEN
   RAISE EXCEPTION 'Only service_role can refund AI credits' USING ERRCODE='insufficient_privilege';
 END IF;
 -- NULL, not 0: nothing was attempted, which is a different fact from
 -- "attempted and moved nothing".
 IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 1000 OR (p_org_id IS NULL AND p_user_id IS NULL) THEN
   RETURN NULL;
 END IF;
 -- S2: the period the DEBIT was taken from, not the one the refund lands in.
 -- NULL reproduces 0484's behaviour exactly, for jobs enqueued before this.
 v_at := coalesce(p_debited_at, now());
 SELECT id, used_this_month INTO v_id, v_used FROM public.ai_credits
 WHERE ((p_org_id IS NOT NULL AND org_id=p_org_id) OR (p_user_id IS NOT NULL AND user_id=p_user_id))
   AND period_start<=v_at AND period_end>v_at
 ORDER BY created_at,id LIMIT 1 FOR UPDATE;
 IF v_id IS NULL THEN RETURN NULL; END IF;
 -- The same arithmetic as 0484's GREATEST(used - amount, 0), written so the
 -- amount actually moved is returned instead of discarded. `GREATEST(...,0)`
 -- also covers a corrupt negative used_this_month.
 v_returned := GREATEST(LEAST(v_used, p_amount), 0);
 UPDATE public.ai_credits
    SET used_this_month=used_this_month-v_returned,updated_at=now()
  WHERE id=v_id;
 RETURN v_returned;
END $$;

-- Re-issued AFTER the CREATE: the DROP took the old function's ACL with it, and
-- a fresh CREATE re-triggers Supabase's ALTER DEFAULT PRIVILEGES, which grants
-- anon/authenticated EXECUTE **directly** — a REVOKE FROM PUBLIC alone would
-- not remove that. Both axes are named explicitly.
REVOKE ALL ON FUNCTION public.refund_ai_credits(uuid,uuid,integer,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_ai_credits(uuid,uuid,integer,timestamptz) TO service_role;

-- The signature changed, so PostgREST's cached one is now wrong: without this
-- every refund 404s with PGRST202. This is the mistake 0467 made and 0483
-- compensates for; it is not repeated.
NOTIFY pgrst, 'reload schema';

COMMIT;
