-- 0420_scrum2538_check_unified_credits_fail_closed.sql
-- SCRUM-2538 / DI-380 — `check_unified_credits` fails OPEN: an org or user with
--   NO `unified_credits` row is told it holds 50 credits. Make it fail CLOSED,
--   after materializing the entitlement that default was inventing.
--
-- ROLLBACK:
--   -- 1. Restore the fail-OPEN bodies exactly as the squashed baseline defines
--   --    them (baseline:1413-1447 and the deduct_unified_credits block above
--   --    delete_own_account). Copy those two CREATE OR REPLACE statements
--   --    verbatim, then re-assert the grants — CREATE OR REPLACE re-triggers
--   --    ALTER DEFAULT PRIVILEGES and would leave both anon-callable:
--   REVOKE ALL ON FUNCTION public.check_unified_credits(uuid, uuid) FROM PUBLIC, anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.check_unified_credits(uuid, uuid) TO service_role;
--   REVOKE ALL ON FUNCTION public.deduct_unified_credits(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.deduct_unified_credits(uuid, uuid, integer) TO service_role;
--   NOTIFY pgrst, 'reload schema';
--   -- 2. The backfilled rows are DELIBERATELY NOT deleted on rollback. They
--   --    carry the same 50-credit entitlement the fail-open branch was
--   --    inventing, so they are a no-op against the restored behavior, and by
--   --    the time a rollback runs they may already record real usage. Deleting
--   --    them would discard that usage and hand every affected owner a fresh
--   --    phantom 50. Nothing about the rollback touches RLS: STEP 1 restores
--   --    FORCE ROW LEVEL SECURITY on every exit path, error path included.
--
-- =============================================================================
-- WHY THIS MIGRATION EXISTS
-- -----------------------------------------------------------------------------
-- The baseline body short-circuits a missing balance row to
--
--   IF NOT FOUND THEN RETURN QUERY SELECT 50, 0, 50, true; RETURN; END IF;
--
-- monthly_allocation 50, remaining 50, has_credits TRUE — for an owner the
-- credit ledger has never heard of. Entitlement invented by the ABSENCE of a
-- record, on a money path, in a SECURITY DEFINER function. Verified live on
-- prod (vzwyaatejekddvltxyye) via pg_get_functiondef, not merely unfixed in
-- the repo.
--
-- It is not a 50-call trial. The sibling `deduct_unified_credits` fails CLOSED
-- on the SAME missing row (`IF NOT FOUND THEN RETURN false`), so the pair
-- disagrees: `check` reports 50, `deduct` debits nothing, and the balance never
-- moves. The phantom 50 regenerates on every call — it is unbounded. The
-- worker's Tier-1 path compounded it by ignoring that boolean entirely; that
-- half is fixed in `services/worker/src/middleware/paymentTierRouter.ts` in the
-- same change.
--
-- SEQUENCING — WHY THE BACKFILL IS PART OF THE FIX
-- -----------------------------------------------------------------------------
-- Flipping the default to 0/false on its own converts a revenue leak into an
-- outage: every owner relying on the phantom 50 drops to zero the instant this
-- applies. So STEP 1 writes REAL rows carrying the SAME 50-credit entitlement
-- (which is also the table's own `monthly_allocation` column default, i.e. the
-- free tier as actually designed). Effective behavior for every existing owner
-- is unchanged; only the fabrication goes away.
--
-- Org rows cover every caller that passes p_org_id. Users with NO org would
-- otherwise regress, so they get their own row — and only they do, which keeps
-- the backfill from ever creating BOTH an org row and a user row for the same
-- caller (see STEP 2's ordering note).
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- -----------------------------------------------------------------------------
--   * It does NOT change the `unified_credits.monthly_allocation` column
--     default of 50. SCRUM-2538 lists it alongside the function default, but it
--     is not the same defect: a column default applies to a row somebody
--     deliberately INSERTed, and 50 is the real free-tier grant. The bug was a
--     function conjuring a row that does not exist. Dropping the column default
--     to 0 would silently zero every future insert path that omits the column —
--     trading this fail-open for a fail-closed of the same shape.
--   * It does NOT add the missing UNIQUE index on `unified_credits(org_id)` /
--     `(user_id)`. The table has only a PK on `id` (baseline:10276), so
--     duplicate rows per owner are representable today. Creating the index here
--     would ABORT the whole migration if prod already holds a duplicate, and
--     that cannot be established from the repo. STEP 2 instead makes both
--     functions pick deterministically, which is safe whether or not duplicates
--     exist. The index is follow-up work and is recorded in
--     `supabase/migrations/agents.md`.
--   * It does NOT create rows for orgs/users added AFTER it applies. Nothing in
--     the schema or the worker provisions a `unified_credits` row on signup, so
--     new owners read 0/false. That is now HONEST rather than fabricated, and
--     it is inert today because the only enforcement consumer
--     (`paymentTierRouter`) is not mounted in `services/worker/src/index.ts`.
--     Row provisioning on org creation MUST land before that middleware is
--     mounted; see the mount guard in paymentTierRouter.ts.
-- =============================================================================

SET LOCAL lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- STEP 1 — materialize the entitlement the fail-open branch was inventing.
-- -----------------------------------------------------------------------------
-- `unified_credits` carries FORCE ROW LEVEL SECURITY (baseline:9480), so the
-- migration's OWN role is subject to its policies — and both of them exclude it:
--
--   service_role_manage_unified_credits  USING (auth.role() = 'service_role')
--   users_read_own_unified_credits       FOR SELECT USING (auth.uid() = user_id ...)
--
-- Inside a migration there is no JWT, so `auth.role()` and `auth.uid()` are NULL
-- and both predicates evaluate NULL -> false. The first policy is FOR ALL with a
-- USING clause and NO WITH CHECK, and Postgres reuses USING as the WITH CHECK in
-- that case — so the INSERTs below are REJECTED outright. Worse, the idempotency
-- guards are filtered too: `NOT EXISTS (SELECT 1 FROM unified_credits ...)`
-- would see ZERO rows and report every owner as uncovered, so a variant that got
-- past the write check would duplicate rows for owners that already have one.
--
-- This is the 0404 lesson, recorded in that file's header: FORCE RLS hides rows
-- from the migration's own SELECT, not just from its writes, and a backfill that
-- scans before suspending reports "nothing to do" and commits a silent no-op.
-- Suspension therefore opens BEFORE the scan and is restored on every exit path,
-- error path included. Unlike 0404 there are no triggers on this table, so RLS
-- is the only control being suspended.
--
-- Reads the hot `organizations` / `profiles` tables (§1.2), hence the bounded
-- lock_timeout above. Writes only to the cold `unified_credits` table. The
-- NOT EXISTS guards make both statements idempotent, so a replay is a no-op.

DO $$
DECLARE
  v_org_rows  bigint  := 0;
  v_user_rows bigint  := 0;
  v_suspended boolean := false;
BEGIN
  ALTER TABLE public.unified_credits NO FORCE ROW LEVEL SECURITY;
  v_suspended := true;

  -- Org rows cover every caller that passes p_org_id.
  INSERT INTO public.unified_credits (org_id, monthly_allocation, used_this_month, carry_over)
  SELECT o.id, 50, 0, 0
  FROM public.organizations o
  WHERE NOT EXISTS (
    SELECT 1 FROM public.unified_credits uc WHERE uc.org_id = o.id
  );
  GET DIAGNOSTICS v_org_rows = ROW_COUNT;

  -- Org-less owners only. A user who belongs to an org is already covered by
  -- that org's row; giving them a second row would make the OR-predicate in
  -- STEP 2 match two rows for one caller.
  INSERT INTO public.unified_credits (user_id, monthly_allocation, used_this_month, carry_over)
  SELECT p.id, 50, 0, 0
  FROM public.profiles p
  WHERE p.org_id IS NULL
    AND p.deleted_at IS NULL
    -- unified_credits.user_id is FK -> auth.users(id) (baseline:12210); a
    -- profile whose auth user is gone would violate it and abort.
    AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id)
    AND NOT EXISTS (
      SELECT 1 FROM public.unified_credits uc WHERE uc.user_id = p.id
    );
  GET DIAGNOSTICS v_user_rows = ROW_COUNT;

  -- Self-verifying, because the failure this guards against is SILENT. If the
  -- suspension had not taken, the reads above would have been filtered and this
  -- re-check would still find uncovered orgs. Refusing to commit is the safe
  -- outcome: a fail-closed check_unified_credits over an incomplete backfill
  -- zeroes real customers.
  IF EXISTS (
    SELECT 1 FROM public.organizations o
    WHERE NOT EXISTS (SELECT 1 FROM public.unified_credits uc WHERE uc.org_id = o.id)
  ) THEN
    RAISE EXCEPTION
      '0420: backfill incomplete — organizations remain with no unified_credits row. '
      'Refusing to commit a fail-closed check_unified_credits that would zero them.';
  END IF;

  ALTER TABLE public.unified_credits FORCE ROW LEVEL SECURITY;
  v_suspended := false;

  RAISE NOTICE '0420: backfilled % org row(s) and % org-less user row(s) into unified_credits.',
    v_org_rows, v_user_rows;

EXCEPTION WHEN others THEN
  IF v_suspended THEN
    ALTER TABLE public.unified_credits FORCE ROW LEVEL SECURITY;
  END IF;
  RAISE;
END $$;

-- -----------------------------------------------------------------------------
-- STEP 2 — check_unified_credits: fail CLOSED, and pick its row deterministically.
-- -----------------------------------------------------------------------------
-- Three changes from the baseline body, all money-safety:
--
--   (a) Missing row returns 0, 0, 0, false instead of 50, 0, 50, true.
--
--   (b) Deterministic row selection. The baseline's bare `LIMIT 1` over an
--       OR-predicate picks an ARBITRARY row when both an org row and a user row
--       match, and `deduct_unified_credits` did the same with no LIMIT at all —
--       so the balance could be READ off one row and DEBITED from another.
--       Both functions now use the identical ordering: org match first
--       (`DESC NULLS LAST` — the comparison is NULL, not false, when uc.org_id
--       is NULL, and NULLs sort FIRST under a bare DESC), then oldest, then id.
--
--   (c) The monthly-rollover carry_over is computed ONCE, from the PRE-reset
--       used_this_month, and used for BOTH the persisted row and the returned
--       value. The baseline recomputed it AFTER `v_record.used_this_month := 0`,
--       so the row was written LEAST(alloc - used, 50) while the caller was told
--       LEAST(alloc, 50) — `remaining` overstated by exactly last month's usage.
--       Another fabricated balance, in the same function, on the same path.
--
-- Signature, LANGUAGE, SECURITY DEFINER, search_path and the healthy-row return
-- shape are preserved verbatim: the API contract does not move.

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
  LIMIT 1;

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

-- -----------------------------------------------------------------------------
-- STEP 3 — deduct_unified_credits: same deterministic row selection.
-- -----------------------------------------------------------------------------
-- Behavior is otherwise IDENTICAL to the baseline, including its existing
-- fail-closed `IF NOT FOUND THEN RETURN false`. The only change is the ORDER BY
-- + LIMIT 1, which must match check_unified_credits exactly or the two can act
-- on different rows. It also stops locking every matching row: the baseline's
-- `SELECT ... FOR UPDATE` with no LIMIT locked them all and then took whichever
-- one plpgsql's SELECT INTO happened to see first.

CREATE OR REPLACE FUNCTION public.deduct_unified_credits(p_org_id uuid DEFAULT NULL::uuid, p_user_id uuid DEFAULT NULL::uuid, p_amount integer DEFAULT 1)
RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_record unified_credits%ROWTYPE;
  v_available integer;
BEGIN
  SELECT * INTO v_record FROM unified_credits uc
  WHERE (p_org_id IS NOT NULL AND uc.org_id = p_org_id)
     OR (p_user_id IS NOT NULL AND uc.user_id = p_user_id)
  ORDER BY (p_org_id IS NOT NULL AND uc.org_id = p_org_id) DESC NULLS LAST,
           uc.created_at,
           uc.id
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  v_available := v_record.monthly_allocation + v_record.carry_over - v_record.used_this_month;
  IF v_available < p_amount THEN RETURN false; END IF;

  UPDATE unified_credits SET used_this_month = used_this_month + p_amount, updated_at = now()
  WHERE id = v_record.id;
  RETURN true;
END;
$$;

ALTER FUNCTION public.deduct_unified_credits(uuid, uuid, integer) OWNER TO postgres;

-- -----------------------------------------------------------------------------
-- STEP 4 — re-assert the grants. NOT optional, and it must come AFTER the
-- definitions above.
-- -----------------------------------------------------------------------------
-- On Supabase, `ALTER DEFAULT PRIVILEGES` (baseline:15095-15096) grants `anon`
-- and `authenticated` EXECUTE **directly** at CREATE time, and CREATE OR REPLACE
-- re-triggers it. 0377/0378 already revoked both of these; redefining them above
-- silently undoes that. Both are SECURITY DEFINER, so the result would be an
-- RLS-bypassing billing RPC callable by anyone over PostgREST — the 0364 / 0377
-- / 0378 / 0388 / 0406 class.
--
-- Written UNQUOTED on purpose: `"public"."f"()` matches neither branch of
-- `scripts/ci/feedback-rules/secdef-function-grants.ts`'s `statementTargets`,
-- so a quoted revoke reads as no revoke at all (0411 hit exactly that).

REVOKE ALL ON FUNCTION public.check_unified_credits(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_unified_credits(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.deduct_unified_credits(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deduct_unified_credits(uuid, uuid, integer) TO service_role;

-- -----------------------------------------------------------------------------
-- STEP 5 — PostgREST holds a schema cache; both function bodies changed.
-- -----------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
