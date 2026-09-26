-- 0484_scrum4939_refund_ai_credits.sql
-- Fixes the AI-credit refund regression from 0467. Ships with 0483 in the same
-- PR and the same T3 window; separate prefix because a migration file is
-- immutable once written (CLAUDE.md §1.2 / §4) and 0483 was already committed.
-- The split is also useful on its own: the refund function can be rolled back
-- without giving up 0483's lock_timeout hardening.
--
-- THE REGRESSION
-- Migration 0467 added `IF p_amount IS NULL OR p_amount <= 0 … RETURN false` to
-- `public.deduct_ai_credits`. That guard is CORRECT — a negative debit is an
-- unbounded credit grant on an RPC whose job is to take credit away — but
-- three live call sites were issuing refunds through exactly that door:
--
--   services/worker/src/api/v1/ai-extract.ts        deductAICredits(org,user,-1)
--   services/worker/src/api/v1/ai-extract-batch.ts  deductAICredits(org,user,-1)
--   services/worker/src/jobs/ai-credit-reconcile.ts deductAICredits(org,user,-amount)
--
-- and `services/worker/src/api/v1/agents.md` documents the intent plainly:
-- "each failed/timed-out row refunds its own single credit". Since 0467 reached
-- prod on 2026-09-19 every one of those returned false and refunded nothing, so
-- a failed or timed-out extraction stayed charged. The third site is the
-- reconciler — the last line of defence against exactly this overcharge — so it
-- reconciled nothing and dead-lettered every job it claimed.
--
-- THE FIX
-- `deduct_ai_credits` stays closed to non-positive amounts. Returning credit is
-- a different operation with a different bound, so it gets its own function.
-- The worker half is `refundAICredits()` in services/worker/src/ai/cost-tracker.ts;
-- `deductAICredits()` now also rejects a non-positive amount in TypeScript so
-- the mistake cannot recur silently behind an RPC that answers false for two
-- different reasons.
--
-- WHY EACH LINE OF THE FUNCTION IS THERE
--   * service_role-only TWICE: the GRANT below, and an in-body caller check,
--     because this function MINTS credit. The predicate is 0466's idiom —
--     `coalesce(public.get_caller_role() = 'service_role', false)` — and NOT a
--     bare `<> 'service_role'`: `get_caller_role()` returns NULL when request
--     claims are absent, and a NULL comparison makes a PL/pgSQL `IF` fall
--     through, i.e. fail OPEN. That is the exact defect 0466 compensated for in
--     0456, and the one 0468's `auth.role() != 'service_role'` still carries.
--   * `p_amount` is bounded at 1000 — the same ceiling `MAX_RECONCILABLE_AMOUNT`
--     in services/worker/src/jobs/ai-credit-reconcile.ts has enforced on this
--     operation since it shipped, for the same stated reason: every real caller
--     refunds exactly 1 (one row's credit), so anything near the ceiling is
--     already a bug, and the bound stops a corrupted caller minting a balance.
--     `MAX_REFUNDABLE_AMOUNT` in cost-tracker.ts is pinned equal by test.
--   * It locks the SAME row the debit locks: identical selection predicate and
--     `ORDER BY created_at,id LIMIT 1 FOR UPDATE` (0467 lines 36-41), so a debit
--     and a refund for one org serialize against each other instead of
--     interleaving on a stale read. 0467's `ai_credits_org_period_no_overlap`
--     exclusion constraint guarantees at most one ACTIVE period per org (and
--     per user), so that `LIMIT 1` is the whole active period, not an arbitrary
--     pick among several.
--   * `GREATEST(used_this_month - p_amount, 0)` — a refund can never drive the
--     period negative, so it can never mint credit beyond what the period
--     actually consumed. This is also the bound on a DOUBLE refund. There is no
--     idempotency key on this operation today: the reconcile payload carries a
--     fingerprint, but the job legitimately retries, so a refund that COMMITS
--     and whose response is then lost (client timeout, instance recycle) is
--     re-applied by the reconciler. The floor caps that at this period's
--     `used_this_month` — it can over-return within a month, but it can never
--     produce a net credit grant. No key is invented here; the callers do not
--     carry one.
--   * Returns true only when a row was actually updated. No covering period row
--     returns false — there is nothing to refund.
--   * `SET lock_timeout='5s'`, matching 0483's debit and 0467's
--     `ensure_ai_credits_period`: behind a stuck holder it aborts with SQLSTATE
--     55P03 having refunded nothing, rather than pinning a worker request slot
--     until `statement_timeout`.
--
-- READ-ONLY PRECONDITION SELECTS for the operator, to run against prod BEFORE
-- applying (none of them write):
--   -- 1. The function must not already exist under a different definition:
--   SELECT p.proname, p.proconfig, p.prosecdef, p.proacl
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'refund_ai_credits';
--   -- 2. get_caller_role() must exist (the in-body guard depends on it):
--   SELECT pg_get_functiondef(p.oid)
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'get_caller_role';
--   -- 3. BLAST RADIUS of the regression — how much credit was taken and never
--   --    returned since 0467 reached prod. Read-only; DO NOT run it from an
--   --    agent session (CLAUDE.md: no hosted SQL from here). `ai_usage_events`
--   --    is the only table that records per-extraction outcomes, and the
--   --    failure rows are exactly the ones whose credit should have come back:
--   --      SELECT date_trunc('day', created_at) AS day,
--   --             org_id, user_id,
--   --             count(*)                      AS failed_extractions,
--   --             sum(coalesce(credits_consumed, 1)) AS credits_not_refunded
--   --        FROM public.ai_usage_events
--   --       WHERE success = false
--   --         AND event_type IN ('extraction','embedding')
--   --         AND created_at >= timestamptz '2026-09-19'
--   --       GROUP BY 1, 2, 3
--   --       ORDER BY 1, 4 DESC;
--   --    Cross-check the queue that was supposed to catch the rest — every row
--   --    here is an overcharge the reconciler could not fix either:
--   --      SELECT status, count(*), min(created_at), max(created_at)
--   --        FROM public.job_queue
--   --       WHERE type = 'ai_credits.reconcile_refund'
--   --         AND created_at >= timestamptz '2026-09-19'
--   --       GROUP BY 1;
--   --    Caveats to state when reporting the number: rows whose debit was
--   --    skipped (cached rows, unmetered-beta orgs with a null balance) were
--   --    never charged and must not be counted, and `credits_consumed` is the
--   --    producer's own field rather than a ledger read. Treat the result as an
--   --    upper bound on the goodwill credit owed, not an exact ledger delta.
--
-- ROLLBACK:
--   -- Dropping this function WITHOUT reverting the worker callers re-creates
--   -- the overcharge: `refundAICredits()` would fail on every call with
--   -- PGRST202/42883 and no refund would be applied. Revert the worker commits
--   -- that introduced `refundAICredits` (services/worker/src/ai/cost-tracker.ts,
--   -- api/v1/ai-extract.ts, api/v1/ai-extract-batch.ts,
--   -- jobs/ai-credit-reconcile.ts) and redeploy the worker BEFORE running this.
--   -- Note what you are rolling back TO: the 0467 behaviour in which refunds
--   -- silently do nothing. Prefer fixing forward.
--   BEGIN;
--   SET LOCAL lock_timeout = '5s';
--   DROP FUNCTION IF EXISTS public.refund_ai_credits(uuid,uuid,integer);
--   NOTIFY pgrst, 'reload schema';
--   COMMIT;

BEGIN;

-- No hot-table DDL in this file (CLAUDE.md §1.2 names organizations/anchors/
-- profiles); the statement-level guard is kept anyway so a future edit cannot
-- inherit an unbounded lock queue.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.refund_ai_credits(p_org_id uuid DEFAULT NULL,p_user_id uuid DEFAULT NULL,p_amount integer DEFAULT 1)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path='public' SET lock_timeout='5s' AS $$
DECLARE v_id uuid; v_rows integer := 0;
BEGIN
 IF NOT coalesce(public.get_caller_role() = 'service_role', false) THEN
   RAISE EXCEPTION 'Only service_role can refund AI credits' USING ERRCODE='insufficient_privilege';
 END IF;
 IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 1000 OR (p_org_id IS NULL AND p_user_id IS NULL) THEN
   RETURN false;
 END IF;
 SELECT id INTO v_id FROM public.ai_credits
 WHERE ((p_org_id IS NOT NULL AND org_id=p_org_id) OR (p_user_id IS NOT NULL AND user_id=p_user_id))
   AND period_start<=now() AND period_end>now()
 ORDER BY created_at,id LIMIT 1 FOR UPDATE;
 IF v_id IS NULL THEN RETURN false; END IF;
 UPDATE public.ai_credits
    SET used_this_month=GREATEST(used_this_month-p_amount,0),updated_at=now()
  WHERE id=v_id;
 GET DIAGNOSTICS v_rows = ROW_COUNT;
 RETURN v_rows = 1;
END $$;

-- CREATE OR REPLACE re-triggers Supabase's ALTER DEFAULT PRIVILEGES, which
-- grants anon/authenticated EXECUTE **directly** — a REVOKE FROM PUBLIC alone
-- would not remove that. Both axes are named explicitly.
REVOKE ALL ON FUNCTION public.refund_ai_credits(uuid,uuid,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_ai_credits(uuid,uuid,integer) TO service_role;

-- New RPC: PostgREST will 404/PGRST202 on it until the schema cache reloads.
-- This is the mistake 0467 made and 0483 compensates for; it is not repeated.
NOTIFY pgrst, 'reload schema';

COMMIT;
