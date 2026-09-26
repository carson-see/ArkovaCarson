-- 0483_scrum4939_credit_rpc_followups.sql
-- SCRUM-4939 follow-ups. Compensating migration for 0467 (#2999) and 0468
-- (#3004), both already APPLIED ON PROD and therefore immutable (CLAUDE.md §6:
-- "Never modify an existing migration — write a compensating one").
--
-- Three independent corrections, none of which changes any function's
-- signature, return shape or business logic:
--
--   (1) 0467 has NO `NOTIFY pgrst, 'reload schema';`. It introduced a NEW RPC,
--       `public.ensure_ai_credits_period(uuid,integer,timestamptz)`. PostgREST
--       serves RPCs from a cached schema, so until that cache refreshes the new
--       function is invisible and `POST /rpc/ensure_ai_credits_period` answers
--       404 / PGRST202. `ensureAICreditsPeriod()` in
--       services/worker/src/ai/cost-tracker.ts logs that at `warn` and returns
--       false (it fails soft by design), so provisioning silently does not
--       happen and the org's first extraction hard-fails — the exact bug #2999
--       was written to fix. This file issues the NOTIFY. It is harmless if the
--       cache has already caught up on its own.
--
--   (2) 0467's `deduct_ai_credits` does `SELECT … FOR UPDATE` with NO
--       lock_timeout, while `ensure_ai_credits_period` in the SAME file sets
--       `lock_timeout='5s'`. Behind a stuck holder of the org's `ai_credits`
--       row the debit blocks until `statement_timeout` instead of failing fast,
--       holding a worker request slot for the whole window. Replaced below with
--       the IDENTICAL body, plus a function-level `SET lock_timeout TO '5s'` —
--       matching how 0467 hardened its sibling. Direction of failure is
--       unchanged and safe: a lock timeout aborts the transaction with SQLSTATE
--       55P03, no debit is recorded, the RPC error reaches `deductAICredits()`
--       which returns false, and every paid caller fails CLOSED (ai-extract.ts
--       503; ai-extract-batch.ts skips the row; embeddings.ts rolls the stored
--       embedding back — the last of those is fixed in this same PR).
--
--   (3) Defense in depth on `public.allocate_monthly_credits()` — see the
--       CORRECTED 0468 rollback note below. The REVOKE/GRANT pair is
--       re-asserted unconditionally. It is idempotent and a no-op when the ACL
--       is already correct.
--
-- NOT changed here, deliberately, and reported instead of widened into:
--   0467 added `IF p_amount IS NULL OR p_amount <= 0 THEN RETURN false` to
--   `deduct_ai_credits`. The pre-0467 (baseline) body had no such guard, and
--   three live call sites pass a NEGATIVE amount to perform a REFUND
--   (api/v1/ai-extract.ts `deductAICredits(org,user,-1)`,
--   api/v1/ai-extract-batch.ts, and the whole jobs/ai-credit-reconcile.ts
--   reconciler). Under 0467 every one of those returns false and refunds
--   nothing — orgs stay charged for extractions that failed. That is a
--   behavioural regression needing its own ticket, its own soak and a product
--   decision on whether service_role may push credit the other way; it is not
--   smuggled into a lock-timeout fix.
--
-- ============================================================================
-- CORRECTED ROLLBACK PROCEDURE FOR MIGRATION 0468 (0468 itself cannot be edited)
-- ============================================================================
-- 0468's own comment says: restore allocate_monthly_credits() "from the
-- baseline definition". DO NOT DO THAT. Following it literally reopens a
-- security hole that 0377 deliberately closed:
--
--   * `00000000000000_baseline_at_main_HEAD.sql` lines 13507-13509 GRANT ALL on
--     `allocate_monthly_credits()` to "anon" AND "authenticated". 0377
--     (`0377_sec_recon_revoke_unguarded_rpc_family.sql`, lines 41-45 and 196)
--     revoked exactly that, describing it as: "Zero-arg, zero-auth. […]
--     Anon-callable = anyone can trigger a platform-wide credit reallocation on
--     demand."
--   * The baseline body (lines 752-800) also predates BOTH of 0468's
--     hardenings: no `auth.role() != 'service_role'` guard and no
--     `pg_try_advisory_xact_lock(8675309, 3)` singleton, and its loop has no
--     `FOR UPDATE OF c`.
--
-- The true pre-0468 state is: the BASELINE BODY with the POST-0377 GRANTS.
-- No migration between the baseline and 0468 redefines the function
-- (`grep -rn allocate_monthly_credits supabase/migrations/` returns only the
-- baseline, 0377's revoke plus commentary, and 0468), so the baseline body is
-- the right body — but the baseline GRANTS are not the right grants. A rollback
-- of 0468 is therefore:
--
--   -- 1. restore ONLY the pre-0468 BODY (baseline lines 752-800, verbatim):
--   CREATE OR REPLACE FUNCTION public.allocate_monthly_credits() RETURNS integer
--       LANGUAGE plpgsql SECURITY DEFINER
--       SET search_path TO 'public'
--       AS $rb$
--   DECLARE
--     v_count integer := 0;
--     v_record RECORD;
--     v_plan_allocation integer;
--     v_expired_monthly integer;
--   BEGIN
--     FOR v_record IN
--       SELECT c.*, s.plan_id, p.name as plan_name
--       FROM credits c
--       LEFT JOIN subscriptions s ON s.user_id = c.user_id AND s.status IN ('active', 'trialing')
--       LEFT JOIN plans p ON p.id = s.plan_id
--       WHERE c.cycle_end <= now()
--     LOOP
--       v_plan_allocation := CASE v_record.plan_name
--         WHEN 'Individual' THEN 500
--         WHEN 'Professional' THEN 5000
--         ELSE 50
--       END;
--       v_expired_monthly := GREATEST(0, v_record.balance - v_record.purchased);
--       IF v_expired_monthly > 0 THEN
--         INSERT INTO credit_transactions (user_id, transaction_type, amount, balance_after, reason)
--         VALUES (v_record.user_id, 'EXPIRY', -v_expired_monthly,
--                 v_record.purchased, 'Monthly credits expired');
--       END IF;
--       UPDATE credits SET
--         balance = v_record.purchased + v_plan_allocation,
--         monthly_allocation = v_plan_allocation,
--         cycle_start = date_trunc('month', now()),
--         cycle_end = date_trunc('month', now()) + interval '1 month',
--         updated_at = now()
--       WHERE id = v_record.id;
--       INSERT INTO credit_transactions (user_id, transaction_type, amount, balance_after, reason)
--       VALUES (v_record.user_id, 'ALLOCATION', v_plan_allocation,
--               v_record.purchased + v_plan_allocation, 'Monthly credit allocation');
--       v_count := v_count + 1;
--     END LOOP;
--     RETURN v_count;
--   END;
--   $rb$;
--   -- 2. IMMEDIATELY re-close the 0377 hole that the CREATE OR REPLACE just
--   --    re-opened (Supabase ALTER DEFAULT PRIVILEGES re-grants anon and
--   --    authenticated DIRECTLY on every replace — a REVOKE FROM PUBLIC alone
--   --    does NOT remove a direct role grant):
--   REVOKE ALL ON FUNCTION public.allocate_monthly_credits() FROM PUBLIC, anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.allocate_monthly_credits() TO service_role;
--   NOTIFY pgrst, 'reload schema';
--
-- Rolling back 0468 also removes its `auth.role()` guard, so after the rollback
-- the ONLY thing keeping the RPC off the public internet is that GRANT line.
-- It is not optional.
-- ============================================================================
--
-- READ-ONLY PRECONDITION SELECTS for the operator, to run against prod BEFORE
-- applying (none of them write):
--   SELECT p.proname, p.proconfig, p.prosecdef, pg_get_userbyid(p.proowner) AS owner,
--          p.proacl
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname IN ('deduct_ai_credits','ensure_ai_credits_period',
--                        'check_ai_credits','allocate_monthly_credits')
--    ORDER BY p.proname;
--   SELECT p.proname,
--          has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_exec,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed_exec,
--          has_function_privilege('service_role',  p.oid, 'EXECUTE') AS service_exec
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname IN ('deduct_ai_credits','ensure_ai_credits_period',
--                        'check_ai_credits','allocate_monthly_credits')
--    ORDER BY p.proname;
--   -- Is the new RPC visible to PostgREST yet (i.e. did 0467's missing NOTIFY
--   -- already get covered by some later reload)? An HTTP probe is the only
--   -- authoritative answer — pg_proc says nothing about the PostgREST cache:
--   --   curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
--   --     "$SUPABASE_URL/rest/v1/rpc/ensure_ai_credits_period" \
--   --     -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
--   --     -H 'Content-Type: application/json' \
--   --     -d '{"p_org_id":"00000000-0000-0000-0000-000000000000","p_monthly_allocation":0}'
--   --   404 / PGRST202 => stale cache, this migration's NOTIFY is load-bearing.
--   --   A 200 means the cache already has it and the NOTIFY is a no-op. The
--   --   zero uuid matches no organization, so the call provisions a row for that
--   --   id alone; delete it afterwards if the probe returns 200.
--
-- ROLLBACK:
--   -- Restores 0467's deduct_ai_credits verbatim (no lock_timeout). Runnable as
--   -- written. Do NOT roll back step (3) below: re-asserting 0377's grants is a
--   -- security correction, and reverting it would hand anon EXECUTE back.
--   BEGIN;
--   SET LOCAL lock_timeout = '5s';
--   CREATE OR REPLACE FUNCTION public.deduct_ai_credits(p_org_id uuid DEFAULT NULL,p_user_id uuid DEFAULT NULL,p_amount integer DEFAULT 1)
--   RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='public' AS $rb$
--   DECLARE v_id uuid; v_remaining integer;
--   BEGIN
--    IF p_amount IS NULL OR p_amount <= 0 OR (p_org_id IS NULL AND p_user_id IS NULL) THEN RETURN false; END IF;
--    SELECT id,monthly_allocation-used_this_month INTO v_id,v_remaining FROM public.ai_credits
--    WHERE ((p_org_id IS NOT NULL AND org_id=p_org_id) OR (p_user_id IS NOT NULL AND user_id=p_user_id))
--      AND period_start<=now() AND period_end>now()
--    ORDER BY created_at,id LIMIT 1 FOR UPDATE;
--    IF v_id IS NULL OR v_remaining<p_amount THEN RETURN false; END IF;
--    UPDATE public.ai_credits SET used_this_month=used_this_month+p_amount,updated_at=now() WHERE id=v_id;
--    RETURN true;
--   END $rb$;
--   REVOKE ALL ON FUNCTION public.deduct_ai_credits(uuid,uuid,integer) FROM PUBLIC, anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.deduct_ai_credits(uuid,uuid,integer) TO service_role;
--   NOTIFY pgrst, 'reload schema';
--   COMMIT;

BEGIN;

-- No hot-table DDL in this file (CLAUDE.md §1.2 names organizations/anchors/
-- profiles); the statement-level guard is kept anyway so a future edit cannot
-- inherit an unbounded lock queue.
SET LOCAL lock_timeout = '5s';

-- (2) deduct_ai_credits: 0467's body verbatim + a function-level lock_timeout.
CREATE OR REPLACE FUNCTION public.deduct_ai_credits(p_org_id uuid DEFAULT NULL,p_user_id uuid DEFAULT NULL,p_amount integer DEFAULT 1)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path='public' SET lock_timeout='5s' AS $$
DECLARE v_id uuid; v_remaining integer;
BEGIN
 IF p_amount IS NULL OR p_amount <= 0 OR (p_org_id IS NULL AND p_user_id IS NULL) THEN RETURN false; END IF;
 SELECT id,monthly_allocation-used_this_month INTO v_id,v_remaining FROM public.ai_credits
 WHERE ((p_org_id IS NOT NULL AND org_id=p_org_id) OR (p_user_id IS NOT NULL AND user_id=p_user_id))
   AND period_start<=now() AND period_end>now()
 ORDER BY created_at,id LIMIT 1 FOR UPDATE;
 IF v_id IS NULL OR v_remaining<p_amount THEN RETURN false; END IF;
 UPDATE public.ai_credits SET used_this_month=used_this_month+p_amount,updated_at=now() WHERE id=v_id;
 RETURN true;
END $$;

-- CREATE OR REPLACE re-triggers Supabase's ALTER DEFAULT PRIVILEGES, which
-- grants anon/authenticated EXECUTE **directly** — a REVOKE FROM PUBLIC alone
-- would not remove that. Both axes are named explicitly.
REVOKE ALL ON FUNCTION public.deduct_ai_credits(uuid,uuid,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deduct_ai_credits(uuid,uuid,integer) TO service_role;

-- (3) Defense in depth for the corrected 0468 rollback documented above. This
-- file does not redefine allocate_monthly_credits (0468 owns its body); it only
-- re-asserts 0377's ACL so a partial or literal 0468 rollback, or any replay
-- that re-triggered default privileges, cannot leave the platform-wide credit
-- reallocation RPC anon-callable.
REVOKE ALL ON FUNCTION public.allocate_monthly_credits() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_monthly_credits() TO service_role;

-- (1) The NOTIFY 0467 omitted. Queued now, delivered at COMMIT. Covers both the
-- new ensure_ai_credits_period RPC and this file's own replacement of
-- deduct_ai_credits.
NOTIFY pgrst, 'reload schema';

COMMIT;
