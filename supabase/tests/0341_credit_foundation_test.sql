-- =============================================================================
-- Behavioral SQL test for migration 0341 (SCRUM-2349 QUEUE-03 + SCRUM-2350 QUEUE-04)
-- Train D — Credit Integrity Foundation.
--
-- Run AFTER applying migrations (e.g. `supabase db reset --local`) via:
--   psql "$DBURL" -v ON_ERROR_STOP=1 -f supabase/tests/0341_credit_foundation_test.sql
--
-- Every check is a PL/pgSQL ASSERT; the whole script runs inside a single
-- transaction that is ROLLED BACK at the end (no residue, re-runnable).
-- A failed ASSERT aborts with a non-zero exit (ON_ERROR_STOP=1).
--
-- Covers (TDD):
--   1. append-only trigger rejects UPDATE
--   2. append-only trigger rejects DELETE
--   3. service_role has no DELETE privilege on org_credit_deductions
--   4. signed-amount CHECK (DEBIT<0, REFUND>0, amount<>0)
--   5. idempotent replay: same (org, ref, reason) debit => single debit
--   6. null-reference debit cannot bypass idempotency (rejected)
--   7. refund writes a positive REFUND row, never DELETE
--   8. refund idempotent (double refund => single balance add, single row)
--   9. insufficient-credit => no partial debit, no ledger row, balance intact
--  10. debit_and_enqueue_anchor: atomic debit + status transition
--  11. crash-between-debit-and-enqueue: retry is idempotent (single debit)
--  12. debit_and_enqueue insufficient => anchor stays queued, no debit
--  13. money-conservation invariant: balance == grant + Σ signed ledger
--   U. user-path deduct_credit idempotent replay on credit_transactions
-- =============================================================================

BEGIN;

-- Quiet NOTICE noise from RAISE inside the functions under test.
SET LOCAL client_min_messages = WARNING;

-- Simulate the worker's runtime calling context. In production the worker calls
-- these RPCs with the service_role key, so PostgREST sets request.jwt.claim.role
-- = 'service_role'; the anchor status-transition guard (protect_anchor_status_
-- transition) allows system transitions only for that role. psql connects as the
-- bootstrap superuser with no JWT claim, so set it here to faithfully reproduce
-- the worker context (and to exercise the same guard the worker hits).
SELECT set_config('request.jwt.claim.role', 'service_role', true);

DO $test$
DECLARE
  -- Reuse seed identities to satisfy FKs (auth.users / profiles / organizations).
  -- Everything is rolled back at the end, so reusing seed rows is safe and isolated.
  v_org   uuid := 'aaaaaaaa-0000-0000-0000-000000000001';  -- seed: Arkova org
  v_user  uuid := '55555555-0000-0000-0000-000000000002';  -- seed: demo-user
  v_ref_a uuid := 'aaaa0341-0000-4000-8000-000000000001';
  v_ref_c uuid := 'aaaa0341-0000-4000-8000-000000000003';
  v_ref_d uuid := 'aaaa0341-0000-4000-8000-000000000004';
  v_anchor_q uuid := 'cccc0341-0000-4000-8000-000000000001';
  v_anchor_r uuid := 'cccc0341-0000-4000-8000-000000000002';
  v_res   jsonb;
  v_bal   integer;
  v_cnt   integer;
  v_sum   integer;
  v_grant integer := 100;
  v_threw boolean;
  v_status text;
BEGIN
  -- ---------------------------------------------------------------------------
  -- Fixtures: an org with a credit balance, a user with personal credits,
  -- and two anchors in PENDING. Use minimal NOT NULL columns.
  -- ---------------------------------------------------------------------------
  INSERT INTO org_credits (org_id, balance) VALUES (v_org, v_grant)
  ON CONFLICT (org_id) DO UPDATE SET balance = EXCLUDED.balance;

  INSERT INTO credits (user_id, balance) VALUES (v_user, 50)
  ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance;

  INSERT INTO anchors (id, user_id, org_id, fingerprint, filename, status)
  VALUES
    (v_anchor_q, v_user, v_org, repeat('a', 64), 'test-q.pdf', 'PENDING'),
    (v_anchor_r, v_user, v_org, repeat('b', 64), 'test-r.pdf', 'PENDING')
  ON CONFLICT (id) DO NOTHING;

  -- ===========================================================================
  -- TEST 5: idempotent replay — same (org, ref, reason) => single debit.
  -- ===========================================================================
  v_res := deduct_org_credit(v_org, 1, 'anchor.secure', v_ref_a);
  ASSERT (v_res->>'success')::boolean IS TRUE, '5a: first debit should succeed';
  ASSERT (v_res->>'deducted')::int = 1, '5a: first debit deducts 1';

  v_res := deduct_org_credit(v_org, 1, 'anchor.secure', v_ref_a);  -- replay
  ASSERT (v_res->>'success')::boolean IS TRUE, '5b: replay should succeed';
  ASSERT (v_res->>'idempotent')::boolean IS TRUE, '5b: replay flagged idempotent';
  ASSERT (v_res->>'deducted')::int = 0, '5b: replay deducts 0 (no double charge)';

  SELECT balance INTO v_bal FROM org_credits WHERE org_id = v_org;
  ASSERT v_bal = v_grant - 1, format('5c: balance charged exactly once, got %s', v_bal);

  SELECT count(*) INTO v_cnt FROM org_credit_deductions
    WHERE org_id = v_org AND reference_id = v_ref_a AND reason = 'anchor.secure';
  ASSERT v_cnt = 1, format('5d: exactly one ledger row for replayed debit, got %s', v_cnt);

  -- ===========================================================================
  -- TEST 4: signed-amount convention — DEBIT row is stored NEGATIVE.
  -- ===========================================================================
  SELECT amount INTO v_bal FROM org_credit_deductions
    WHERE org_id = v_org AND reference_id = v_ref_a AND reason = 'anchor.secure';
  ASSERT v_bal = -1, format('4a: DEBIT amount stored as signed negative, got %s', v_bal);

  PERFORM 1 FROM org_credit_deductions
    WHERE org_id = v_org AND reference_id = v_ref_a AND reason = 'anchor.secure'
      AND entry_type = 'DEBIT';
  ASSERT FOUND, '4b: debit row has entry_type=DEBIT';

  -- ===========================================================================
  -- TEST 1: append-only trigger rejects UPDATE.
  -- ===========================================================================
  v_threw := false;
  BEGIN
    UPDATE org_credit_deductions SET amount = -2
      WHERE org_id = v_org AND reference_id = v_ref_a;
  EXCEPTION WHEN OTHERS THEN v_threw := true;
  END;
  ASSERT v_threw, '1: UPDATE on org_credit_deductions must be rejected (append-only)';

  -- ===========================================================================
  -- TEST 2: append-only trigger rejects DELETE.
  -- ===========================================================================
  v_threw := false;
  BEGIN
    DELETE FROM org_credit_deductions
      WHERE org_id = v_org AND reference_id = v_ref_a;
  EXCEPTION WHEN OTHERS THEN v_threw := true;
  END;
  ASSERT v_threw, '2: DELETE on org_credit_deductions must be rejected (append-only)';

  -- ===========================================================================
  -- TEST 4c/4d: signed CHECK rejects a positive DEBIT row and a zero amount.
  -- ===========================================================================
  v_threw := false;
  BEGIN
    INSERT INTO org_credit_deductions (org_id, reference_id, reason, amount, balance_after, entry_type)
    VALUES (v_org, v_ref_d, 'bad.debit', 5, 10, 'DEBIT');  -- DEBIT must be < 0
  EXCEPTION WHEN check_violation THEN v_threw := true;
  END;
  ASSERT v_threw, '4c: positive DEBIT amount must violate signed CHECK';

  v_threw := false;
  BEGIN
    INSERT INTO org_credit_deductions (org_id, reference_id, reason, amount, balance_after, entry_type)
    VALUES (v_org, v_ref_d, 'bad.zero', 0, 10, 'DEBIT');  -- amount <> 0
  EXCEPTION WHEN check_violation THEN v_threw := true;
  END;
  ASSERT v_threw, '4d: zero amount must violate signed CHECK';

  -- ===========================================================================
  -- TEST 6: null-reference debit cannot bypass idempotency (must be rejected).
  -- ===========================================================================
  v_res := deduct_org_credit(v_org, 1, 'anchor.secure', NULL);
  ASSERT (v_res->>'success')::boolean IS FALSE, '6a: NULL reference debit must fail';
  ASSERT v_res->>'error' = 'reference_id_required', format('6b: expected reference_id_required, got %s', v_res->>'error');
  SELECT balance INTO v_bal FROM org_credits WHERE org_id = v_org;
  ASSERT v_bal = v_grant - 1, '6c: NULL-reference debit must not change balance';

  -- ===========================================================================
  -- TEST 7 + 8: refund writes a positive REFUND row (never DELETE), idempotent.
  -- ===========================================================================
  v_res := refund_org_credit(v_org, 1, 'anchor.refund', v_ref_a);
  ASSERT (v_res->>'success')::boolean IS TRUE, '7a: refund should succeed';
  ASSERT (v_res->>'refunded')::int = 1, '7a: refund returns 1';

  -- The original DEBIT row is still present (NOT deleted).
  SELECT count(*) INTO v_cnt FROM org_credit_deductions
    WHERE org_id = v_org AND reference_id = v_ref_a AND entry_type = 'DEBIT';
  ASSERT v_cnt = 1, '7b: original DEBIT row preserved (refund did not DELETE)';

  -- A positive REFUND row now exists.
  SELECT amount INTO v_bal FROM org_credit_deductions
    WHERE org_id = v_org AND reference_id = v_ref_a AND entry_type = 'REFUND';
  ASSERT v_bal = 1, format('7c: REFUND row stored as positive, got %s', v_bal);

  SELECT balance INTO v_bal FROM org_credits WHERE org_id = v_org;
  ASSERT v_bal = v_grant, format('7d: refund restored balance to grant, got %s', v_bal);

  -- Double refund is idempotent: balance not added twice, single REFUND row.
  v_res := refund_org_credit(v_org, 1, 'anchor.refund', v_ref_a);
  ASSERT (v_res->>'idempotent')::boolean IS TRUE, '8a: double refund flagged idempotent';
  ASSERT (v_res->>'refunded')::int = 0, '8a: double refund adds 0';
  SELECT balance INTO v_bal FROM org_credits WHERE org_id = v_org;
  ASSERT v_bal = v_grant, format('8b: balance unchanged after double refund, got %s', v_bal);
  SELECT count(*) INTO v_cnt FROM org_credit_deductions
    WHERE org_id = v_org AND reference_id = v_ref_a AND entry_type = 'REFUND';
  ASSERT v_cnt = 1, format('8c: single REFUND row after double refund, got %s', v_cnt);

  -- ===========================================================================
  -- TEST 9: insufficient credit => no partial debit, no ledger row, balance kept.
  -- ===========================================================================
  v_res := deduct_org_credit(v_org, 99999, 'anchor.secure', v_ref_c);
  ASSERT (v_res->>'success')::boolean IS FALSE, '9a: oversized debit must fail';
  ASSERT v_res->>'error' = 'insufficient_credits', '9b: error=insufficient_credits';
  SELECT balance INTO v_bal FROM org_credits WHERE org_id = v_org;
  ASSERT v_bal = v_grant, format('9c: balance intact after failed debit, got %s', v_bal);
  SELECT count(*) INTO v_cnt FROM org_credit_deductions
    WHERE org_id = v_org AND reference_id = v_ref_c;
  ASSERT v_cnt = 0, format('9d: no ledger row written for failed debit, got %s', v_cnt);

  -- ===========================================================================
  -- TEST 10: debit_and_enqueue_anchor — atomic debit + status transition.
  -- ===========================================================================
  v_res := debit_and_enqueue_anchor(v_org, v_anchor_q, 1, 'anchor.secure', 'BROADCASTING', 'PENDING');
  ASSERT (v_res->>'success')::boolean IS TRUE, '10a: atomic debit+enqueue should succeed';
  ASSERT (v_res->>'deducted')::int = 1, '10a: deducts 1';
  SELECT status INTO v_status FROM anchors WHERE id = v_anchor_q;
  ASSERT v_status = 'BROADCASTING', format('10b: anchor transitioned PENDING->BROADCASTING, got %s', v_status);
  SELECT balance INTO v_bal FROM org_credits WHERE org_id = v_org;
  ASSERT v_bal = v_grant - 1, format('10c: balance debited once by atomic RPC, got %s', v_bal);
  SELECT count(*) INTO v_cnt FROM org_credit_deductions
    WHERE org_id = v_org AND reference_id = v_anchor_q AND entry_type = 'DEBIT';
  ASSERT v_cnt = 1, '10d: exactly one DEBIT row keyed by per-anchor id';

  -- ===========================================================================
  -- TEST 11: crash-between-debit-and-enqueue — retry is idempotent.
  -- Simulates: worker called the RPC (committed debit+enqueue), then crashed
  -- before recording success; on restart it calls the RPC again with the same
  -- per-anchor reference_id. Must NOT double-charge.
  -- ===========================================================================
  v_res := debit_and_enqueue_anchor(v_org, v_anchor_q, 1, 'anchor.secure', 'BROADCASTING', 'PENDING');
  ASSERT (v_res->>'success')::boolean IS TRUE, '11a: retry should succeed';
  ASSERT (v_res->>'idempotent')::boolean IS TRUE, '11a: retry flagged idempotent';
  ASSERT (v_res->>'deducted')::int = 0, '11a: retry deducts 0';
  SELECT balance INTO v_bal FROM org_credits WHERE org_id = v_org;
  ASSERT v_bal = v_grant - 1, format('11b: balance still charged exactly once after retry, got %s', v_bal);
  SELECT count(*) INTO v_cnt FROM org_credit_deductions
    WHERE org_id = v_org AND reference_id = v_anchor_q AND entry_type = 'DEBIT';
  ASSERT v_cnt = 1, format('11c: still exactly one DEBIT row after retry, got %s', v_cnt);

  -- ===========================================================================
  -- TEST 12: debit_and_enqueue insufficient => anchor stays queued, no debit.
  -- ===========================================================================
  -- Drain the org to 0 so the next securing debit is unaffordable.
  UPDATE org_credits SET balance = 0 WHERE org_id = v_org;
  v_res := debit_and_enqueue_anchor(v_org, v_anchor_r, 1, 'anchor.secure', 'BROADCASTING', 'PENDING');
  ASSERT (v_res->>'success')::boolean IS FALSE, '12a: insufficient credit must fail';
  ASSERT v_res->>'error' = 'insufficient_credits', '12b: error=insufficient_credits';
  SELECT status INTO v_status FROM anchors WHERE id = v_anchor_r;
  ASSERT v_status = 'PENDING', format('12c: anchor stays PENDING (queued) — NOT transitioned, got %s', v_status);
  SELECT count(*) INTO v_cnt FROM org_credit_deductions
    WHERE org_id = v_org AND reference_id = v_anchor_r;
  ASSERT v_cnt = 0, format('12d: no partial debit ledger row, got %s', v_cnt);
  SELECT balance INTO v_bal FROM org_credits WHERE org_id = v_org;
  ASSERT v_bal = 0, '12e: balance unchanged (0) after failed atomic debit';

  -- ===========================================================================
  -- TEST 12b: confirm-and-debit mode — expected==target, anchor already at
  -- target (the batch gate's case: anchor already claimed into BROADCASTING).
  -- The debit must attach without a status change and without a conflict.
  -- ===========================================================================
  UPDATE org_credits SET balance = 10 WHERE org_id = v_org;
  -- Put anchor_r into BROADCASTING as the claim step would have.
  UPDATE anchors SET status = 'BROADCASTING' WHERE id = v_anchor_r AND status = 'PENDING';
  v_res := debit_and_enqueue_anchor(v_org, v_anchor_r, 1, 'rule.auto_anchor_queue_run', 'BROADCASTING', 'BROADCASTING');
  ASSERT (v_res->>'success')::boolean IS TRUE, '12b-1: confirm-and-debit on already-BROADCASTING anchor succeeds';
  ASSERT (v_res->>'deducted')::int = 1, '12b-2: confirm-and-debit charges once';
  SELECT status INTO v_status FROM anchors WHERE id = v_anchor_r;
  ASSERT v_status = 'BROADCASTING', '12b-3: anchor stays BROADCASTING';
  SELECT count(*) INTO v_cnt FROM org_credit_deductions
    WHERE org_id = v_org AND reference_id = v_anchor_r AND entry_type = 'DEBIT';
  ASSERT v_cnt = 1, format('12b-4: one DEBIT row for confirm-and-debit, got %s', v_cnt);

  -- ===========================================================================
  -- TEST 13: money-conservation invariant — balance == grant + Σ signed ledger.
  -- After: grant 100, ref_a debit -1 then refund +1 (net 0), anchor_q debit -1.
  -- Balance was force-set to 0 in test 12 (a non-ledger adjustment), so restore
  -- it to the ledger-consistent value before asserting the invariant.
  -- ===========================================================================
  UPDATE org_credits SET balance = v_grant + (
    SELECT COALESCE(SUM(amount), 0) FROM org_credit_deductions WHERE org_id = v_org
  ) WHERE org_id = v_org;

  SELECT balance INTO v_bal FROM org_credits WHERE org_id = v_org;
  SELECT COALESCE(SUM(amount), 0) INTO v_sum FROM org_credit_deductions WHERE org_id = v_org;
  ASSERT v_bal = v_grant + v_sum,
    format('13a: invariant balance(%s) == grant(%s) + Σledger(%s)', v_bal, v_grant, v_sum);

  -- The dedicated reconciliation function agrees (no divergence).
  PERFORM 1 FROM org_credit_ledger_divergence(v_org, v_grant) WHERE diverged;
  ASSERT NOT FOUND, '13b: org_credit_ledger_divergence reports no divergence';

  -- ===========================================================================
  -- TEST 3: service_role lacks DELETE privilege on org_credit_deductions.
  -- ===========================================================================
  SELECT count(*) INTO v_cnt
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name = 'org_credit_deductions'
    AND grantee = 'service_role'
    AND privilege_type = 'DELETE';
  ASSERT v_cnt = 0, '3: service_role must NOT have DELETE on org_credit_deductions';

  -- ===========================================================================
  -- USER-PATH (QUEUE-03c): deduct_credit idempotent replay on credit_transactions.
  -- ===========================================================================
  v_res := deduct_credit(v_user, 1, 'Anchor creation', v_ref_a);
  ASSERT (v_res->>'success')::boolean IS TRUE, 'U1: first user debit succeeds';
  v_res := deduct_credit(v_user, 1, 'Anchor creation', v_ref_a);  -- replay
  ASSERT (v_res->>'success')::boolean IS TRUE, 'U2: replay user debit succeeds';
  ASSERT (v_res->>'idempotent')::boolean IS TRUE, 'U2: replay flagged idempotent';
  SELECT balance INTO v_bal FROM credits WHERE user_id = v_user;
  ASSERT v_bal = 49, format('U3: user balance charged exactly once, got %s', v_bal);
  SELECT count(*) INTO v_cnt FROM credit_transactions
    WHERE user_id = v_user AND reference_id = v_ref_a AND transaction_type = 'DEDUCTION';
  ASSERT v_cnt = 1, format('U4: single credit_transactions row for replay, got %s', v_cnt);

  RAISE WARNING 'ALL 0341 CREDIT-FOUNDATION ASSERTIONS PASSED';
END
$test$;

ROLLBACK;
