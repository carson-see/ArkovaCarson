BEGIN;

-- =============================================================================
-- 0341 — Credit Integrity Foundation (Train D)
-- SCRUM-2349 (QUEUE-03) + SCRUM-2350 (QUEUE-04), coupled.
--
-- Fixes a LIVE double-charge vector: today `refund_org_credit` hard-DELETEs the
-- idempotency row in `org_credit_deductions`, so a refund erases the row and a
-- subsequent retry re-charges. And debit→broadcast→best-effort-refund in
-- `batch-anchor.ts` is NOT atomic, so a crash between debit and enqueue leaves a
-- charge with no anchor (`DOUBLE_BILLING_RISK`).
--
-- This migration HARDENS the EXISTING `org_credit_deductions` ledger (added by
-- 0326) — it does NOT add a new ledger:
--   (a) append-only: BEFORE UPDATE OR DELETE trigger rejects all mutation;
--   (b) refund stops DELETEing and INSERTs a positive `entry_type='REFUND'` row
--       (requires dropping the live CHECKs amount>0 / balance_after>=0, adding a
--       signed-amount CHECK, and REVOKE DELETE ON ... FROM service_role);
--   (c) user-path idempotency: partial-unique index on credit_transactions
--       (user_id, reference_id, transaction_type) WHERE reference_id IS NOT NULL,
--       plus the 0326 FOR-UPDATE idempotent-replay pattern ported to deduct_credit;
--   (d) securing debits require a non-null reference_id (idempotency only fires
--       when non-null — a NULL reference is now rejected outright);
--   (e) money-conservation invariant helper + the QUEUE-04 atomic debit+enqueue
--       RPC `debit_and_enqueue_anchor` (debit + anchor transition in ONE txn,
--       reference_id = per-anchor id, NOT batch id; insufficient credit leaves
--       the item queued with no partial debit).
--
-- SIGN CONVENTION (money-conservation): `amount` is the SIGNED delta applied to
-- org_credits.balance — DEBIT < 0, REFUND > 0 (matches the user-path
-- credit_transactions convention where DEDUCTION already stores -p_amount). The
-- invariant is: org_credits.balance == initial_grant + Σ(org_credit_deductions.amount).
--
-- Data migration: existing rows are all debits with positive amount (refund used
-- to DELETE), so they are negated and stamped entry_type='DEBIT' BEFORE the
-- signed CHECK and append-only trigger are installed.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- (1) Add entry_type, backfill, and migrate existing debit rows to signed form.
--     Order matters: this runs BEFORE the append-only trigger + signed CHECK.
-- -----------------------------------------------------------------------------
ALTER TABLE public.org_credit_deductions
  ADD COLUMN IF NOT EXISTS entry_type text NOT NULL DEFAULT 'DEBIT';

-- Existing rows (pre-0341) are all debits with positive `amount` because the old
-- refund path DELETEd rather than inserting. Convert them to the signed
-- convention: DEBIT amounts become negative. Idempotent (only flips positives).
UPDATE public.org_credit_deductions
SET amount = -amount
WHERE amount > 0;

-- -----------------------------------------------------------------------------
-- (2) Replace the unsigned CHECKs with the signed-amount + entry_type CHECK.
--     Carson (DBA premortem): drop org_credit_deductions_amount_check (amount>0)
--     AND org_credit_deductions_balance_after_check (balance_after>=0), add a
--     signed-amount CHECK. balance_after >= 0 is still valid (balance never goes
--     negative) so it is re-added under an explicit name.
-- -----------------------------------------------------------------------------
ALTER TABLE public.org_credit_deductions
  DROP CONSTRAINT IF EXISTS org_credit_deductions_amount_check,
  DROP CONSTRAINT IF EXISTS org_credit_deductions_balance_after_check;

ALTER TABLE public.org_credit_deductions
  ADD CONSTRAINT org_credit_deductions_entry_type_check
    CHECK (entry_type IN ('DEBIT', 'REFUND', 'GRANT', 'REVOKE')),
  ADD CONSTRAINT org_credit_deductions_amount_signed_check
    CHECK (
      amount <> 0
      AND (entry_type <> 'DEBIT'  OR amount < 0)
      AND (entry_type <> 'REFUND' OR amount > 0)
      AND (entry_type <> 'GRANT'  OR amount > 0)
      AND (entry_type <> 'REVOKE' OR amount < 0)
    ),
  ADD CONSTRAINT org_credit_deductions_balance_after_nonneg_check
    CHECK (balance_after >= 0);

COMMENT ON COLUMN public.org_credit_deductions.amount IS
  'Signed delta applied to org_credits.balance: DEBIT/REVOKE < 0, REFUND/GRANT > 0. '
  'Invariant: balance == initial_grant + SUM(amount) over the org.';
COMMENT ON COLUMN public.org_credit_deductions.entry_type IS
  'Ledger entry kind: DEBIT (charge), REFUND (compensation), GRANT/REVOKE (future).';

-- -----------------------------------------------------------------------------
-- (3) Append-only enforcement: reject ALL UPDATE/DELETE on the ledger.
--     Refunds INSERT a new row; nothing legitimately mutates an existing row.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_org_credit_deduction_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION
    'org_credit_deductions is append-only: % is not permitted (use refund_org_credit to write a compensating REFUND row)',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_org_credit_deductions_append_only ON public.org_credit_deductions;
CREATE TRIGGER trg_org_credit_deductions_append_only
  BEFORE UPDATE OR DELETE ON public.org_credit_deductions
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_org_credit_deduction_mutation();

-- Belt-and-suspenders with the trigger: even a future code path cannot DELETE.
REVOKE DELETE ON TABLE public.org_credit_deductions FROM service_role;

-- -----------------------------------------------------------------------------
-- (4) deduct_org_credit — signed DEBIT row, reference_id REQUIRED, idempotent
--     replay (0326 FOR-UPDATE pattern, comparison adjusted for signed storage).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.deduct_org_credit(
  p_org_id uuid,
  p_amount integer,
  p_reason text DEFAULT 'anchor.create',
  p_reference_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance integer;
  v_existing public.org_credit_deductions%ROWTYPE;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
  END IF;

  -- (QUEUE-03d) Securing debits MUST be idempotency-keyed. A NULL reference
  -- would silently skip the ledger insert (an unaudited, double-chargeable
  -- debit), so reject it outright rather than charging without a key.
  IF p_reference_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'reference_id_required');
  END IF;

  SELECT balance INTO v_balance
  FROM org_credits
  WHERE org_id = p_org_id
  FOR UPDATE;

  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'org_not_initialized');
  END IF;

  -- Idempotent replay: a prior DEBIT for (org, reference_id, reason) means this
  -- charge already landed. The stored amount is the SIGNED delta (negative), so
  -- compare against -p_amount.
  SELECT * INTO v_existing
  FROM org_credit_deductions
  WHERE org_id = p_org_id
    AND reference_id = p_reference_id
    AND reason = p_reason
    AND entry_type = 'DEBIT';

  IF FOUND THEN
    IF v_existing.amount <> -p_amount THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'idempotency_key_conflict',
        'reference_id', p_reference_id
      );
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'balance', v_balance,
      'deducted', 0,
      'reason', p_reason,
      'reference_id', p_reference_id,
      'idempotent', true
    );
  END IF;

  IF v_balance < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'insufficient_credits',
      'balance', v_balance,
      'required', p_amount
    );
  END IF;

  UPDATE org_credits
  SET balance = balance - p_amount,
      updated_at = now()
  WHERE org_id = p_org_id
  RETURNING balance INTO v_balance;

  INSERT INTO org_credit_deductions (org_id, reference_id, reason, amount, balance_after, entry_type)
  VALUES (p_org_id, p_reference_id, p_reason, -p_amount, v_balance, 'DEBIT');

  RETURN jsonb_build_object(
    'success', true,
    'balance', v_balance,
    'deducted', p_amount,
    'reason', p_reason,
    'reference_id', p_reference_id,
    'idempotent', false
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- (5) refund_org_credit — INSERT a positive REFUND row, NEVER DELETE. Idempotent
--     under retry (the per-(org, reference_id, reason) unique key + a pre-check
--     under the org_credits row lock). A failed refund can now be safely
--     re-driven by a reconciliation sweeper without erasing the debit's
--     idempotency row.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refund_org_credit(
  p_org_id uuid,
  p_amount integer,
  p_reason text DEFAULT 'anchor.refund',
  p_reference_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance integer;
  v_exists boolean;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
  END IF;

  IF p_reference_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'reference_id_required');
  END IF;

  -- Serialize refunds per org: the FOR UPDATE lock means a concurrent double
  -- refund waits, then sees the committed REFUND row in the check below.
  SELECT balance INTO v_balance
  FROM org_credits
  WHERE org_id = p_org_id
  FOR UPDATE;

  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'org_not_initialized');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM org_credit_deductions
    WHERE org_id = p_org_id
      AND reference_id = p_reference_id
      AND reason = p_reason
      AND entry_type = 'REFUND'
  ) INTO v_exists;

  IF v_exists THEN
    -- Already refunded — do NOT add balance again.
    RETURN jsonb_build_object(
      'success', true,
      'balance', v_balance,
      'refunded', 0,
      'reason', p_reason,
      'reference_id', p_reference_id,
      'idempotent', true
    );
  END IF;

  UPDATE org_credits
  SET balance = balance + p_amount,
      updated_at = now()
  WHERE org_id = p_org_id
  RETURNING balance INTO v_balance;

  INSERT INTO org_credit_deductions (org_id, reference_id, reason, amount, balance_after, entry_type)
  VALUES (p_org_id, p_reference_id, p_reason, p_amount, v_balance, 'REFUND');

  RETURN jsonb_build_object(
    'success', true,
    'balance', v_balance,
    'refunded', p_amount,
    'reason', p_reason,
    'reference_id', p_reference_id,
    'idempotent', false
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- (6) QUEUE-04: debit_and_enqueue_anchor — ONE transaction that debits the org
--     AND transitions the anchor's status atomically. reference_id = per-anchor
--     id (NOT batch id). Replaces the debit→broadcast→best-effort-refund saga's
--     irreversible mis-debit window: either both the debit row + the status
--     transition commit, or neither does. Insufficient credit leaves the item
--     queued/reviewable with NO partial debit.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.debit_and_enqueue_anchor(
  p_org_id uuid,
  p_anchor_id uuid,
  p_amount integer DEFAULT 1,
  p_reason text DEFAULT 'anchor.secure',
  p_target_status anchor_status DEFAULT 'BROADCASTING',
  p_expected_status anchor_status DEFAULT 'PENDING'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout TO '15s'
AS $$
DECLARE
  v_balance integer;
  v_existing public.org_credit_deductions%ROWTYPE;
  v_anchor_status anchor_status;
  v_transitioned integer;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
  END IF;
  IF p_anchor_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'reference_id_required');
  END IF;

  -- Lock the org balance first (single lock-ordering point: org_credits).
  SELECT balance INTO v_balance
  FROM org_credits
  WHERE org_id = p_org_id
  FOR UPDATE;

  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'org_not_initialized');
  END IF;

  -- Idempotent replay (handles crash-after-debit-before-enqueue): a prior DEBIT
  -- for this anchor means the charge already landed. Re-drive the transition if
  -- the anchor is still in the expected state, then return idempotent.
  SELECT * INTO v_existing
  FROM org_credit_deductions
  WHERE org_id = p_org_id
    AND reference_id = p_anchor_id
    AND reason = p_reason
    AND entry_type = 'DEBIT';

  IF FOUND THEN
    UPDATE anchors
    SET status = p_target_status,
        updated_at = now()
    WHERE id = p_anchor_id
      AND status = p_expected_status;

    SELECT status INTO v_anchor_status FROM anchors WHERE id = p_anchor_id;

    RETURN jsonb_build_object(
      'success', true,
      'balance', v_balance,
      'deducted', 0,
      'reason', p_reason,
      'reference_id', p_anchor_id,
      'anchor_status', v_anchor_status,
      'idempotent', true
    );
  END IF;

  -- Insufficient credit: leave the anchor untouched (queued/reviewable). No
  -- partial debit, no ledger row.
  IF v_balance < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'insufficient_credits',
      'balance', v_balance,
      'required', p_amount
    );
  END IF;

  -- Atomic: transition the anchor and debit together. If the anchor is not in
  -- the expected state (concurrent claim / wrong state), nothing is charged —
  -- the whole function returns before any write. We transition FIRST so a 0-row
  -- result short-circuits cleanly.
  --
  -- "Confirm-and-debit" mode: when p_expected_status = p_target_status (the batch
  -- gate's case — the anchor was already claimed into BROADCASTING and we only
  -- want to atomically attach the debit), an anchor already at the target counts
  -- as a valid debit target rather than a conflict.
  UPDATE anchors
  SET status = p_target_status,
      updated_at = now()
  WHERE id = p_anchor_id
    AND status = p_expected_status;
  GET DIAGNOSTICS v_transitioned = ROW_COUNT;

  IF v_transitioned = 0 THEN
    SELECT status INTO v_anchor_status FROM anchors WHERE id = p_anchor_id;
    -- Confirm-and-debit: already at the target status is acceptable.
    IF NOT (p_expected_status = p_target_status AND v_anchor_status = p_target_status) THEN
      -- Anchor missing or not in expected state: do NOT debit. Caller leaves the
      -- item for retry / review.
      RETURN jsonb_build_object(
        'success', false,
        'error', 'anchor_not_in_expected_status',
        'anchor_status', v_anchor_status,
        'expected_status', p_expected_status
      );
    END IF;
  END IF;

  UPDATE org_credits
  SET balance = balance - p_amount,
      updated_at = now()
  WHERE org_id = p_org_id
  RETURNING balance INTO v_balance;

  INSERT INTO org_credit_deductions (org_id, reference_id, reason, amount, balance_after, entry_type)
  VALUES (p_org_id, p_anchor_id, p_reason, -p_amount, v_balance, 'DEBIT');

  RETURN jsonb_build_object(
    'success', true,
    'balance', v_balance,
    'deducted', p_amount,
    'reason', p_reason,
    'reference_id', p_anchor_id,
    'anchor_status', p_target_status,
    'idempotent', false
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- (7) Money-conservation reconciliation: balance == grant + Σ signed ledger.
--     Returns one row per org with the divergence; a daily sweeper/alarm queries
--     `WHERE diverged`. `p_initial_grant` is the org's lifetime granted credits
--     (allocations live outside this ledger today, so the caller supplies it;
--     defaults to 0 for orgs that only ever debited/refunded).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.org_credit_ledger_divergence(
  p_org_id uuid DEFAULT NULL,
  p_initial_grant integer DEFAULT 0
)
RETURNS TABLE (
  org_id uuid,
  balance integer,
  ledger_sum bigint,
  expected integer,
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
    COALESCE(led.ledger_sum, 0) AS ledger_sum,
    (p_initial_grant + COALESCE(led.ledger_sum, 0))::integer AS expected,
    (oc.balance - (p_initial_grant + COALESCE(led.ledger_sum, 0)))::bigint AS divergence,
    oc.balance <> (p_initial_grant + COALESCE(led.ledger_sum, 0)) AS diverged
  FROM org_credits oc
  LEFT JOIN (
    SELECT d.org_id, SUM(d.amount)::bigint AS ledger_sum
    FROM org_credit_deductions d
    GROUP BY d.org_id
  ) led ON led.org_id = oc.org_id
  WHERE p_org_id IS NULL OR oc.org_id = p_org_id;
$$;

-- -----------------------------------------------------------------------------
-- (8) USER-PATH (QUEUE-03c): idempotent deduct_credit on credit_transactions.
--     Partial-unique index keyed on (user_id, reference_id, transaction_type)
--     WHERE reference_id IS NOT NULL, plus the 0326 FOR-UPDATE replay pattern.
--     credit_transactions already stores DEDUCTION amounts as -p_amount, so the
--     replay comparison uses -p_amount (consistent with the org ledger).
--     NOTE: created NON-concurrently inside this migration so the idempotency
--     guarantee is atomic with the function rewrite and deterministically
--     testable; credit_transactions writes are short, so the brief lock at apply
--     time is acceptable (table is not a sustained hot-write path).
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_transactions_user_reference_type
  ON public.credit_transactions (user_id, reference_id, transaction_type)
  WHERE reference_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.deduct_credit(
  p_user_id uuid,
  p_amount integer DEFAULT 1,
  p_reason text DEFAULT 'Anchor creation',
  p_reference_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_balance integer;
  v_new_balance integer;
  v_existing public.credit_transactions%ROWTYPE;
BEGIN
  SELECT balance INTO v_current_balance
  FROM credits
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_current_balance IS NULL THEN
    RETURN jsonb_build_object('error', 'No credit record found', 'success', false);
  END IF;

  -- Idempotent replay: a prior DEDUCTION for (user, reference_id) means this
  -- charge already landed. Only fires when a reference_id is supplied.
  IF p_reference_id IS NOT NULL THEN
    SELECT * INTO v_existing
    FROM credit_transactions
    WHERE user_id = p_user_id
      AND reference_id = p_reference_id
      AND transaction_type = 'DEDUCTION';

    IF FOUND THEN
      IF v_existing.amount <> -p_amount THEN
        RETURN jsonb_build_object(
          'success', false,
          'error', 'idempotency_key_conflict',
          'reference_id', p_reference_id
        );
      END IF;

      RETURN jsonb_build_object(
        'success', true,
        'balance', v_current_balance,
        'deducted', 0,
        'idempotent', true
      );
    END IF;
  END IF;

  IF v_current_balance < p_amount THEN
    RETURN jsonb_build_object(
      'error', 'Insufficient credits',
      'success', false,
      'balance', v_current_balance,
      'required', p_amount
    );
  END IF;

  v_new_balance := v_current_balance - p_amount;

  UPDATE credits
  SET balance = v_new_balance, updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO credit_transactions (user_id, transaction_type, amount, balance_after, reason, reference_id)
  VALUES (p_user_id, 'DEDUCTION', -p_amount, v_new_balance, p_reason, p_reference_id);

  RETURN jsonb_build_object(
    'success', true,
    'balance', v_new_balance,
    'deducted', p_amount
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- (9) Grants. deduct_org_credit keeps its anon/authenticated/service grants
--     (matches 0326). refund + atomic RPC + divergence are service-role only.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.deduct_org_credit(uuid, integer, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.deduct_org_credit(uuid, integer, text, uuid) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.refund_org_credit(uuid, integer, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_org_credit(uuid, integer, text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.debit_and_enqueue_anchor(uuid, uuid, integer, text, anchor_status, anchor_status) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_and_enqueue_anchor(uuid, uuid, integer, text, anchor_status, anchor_status) TO service_role;

REVOKE ALL ON FUNCTION public.org_credit_ledger_divergence(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.org_credit_ledger_divergence(uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION public.deduct_credit(uuid, integer, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.deduct_credit(uuid, integer, text, uuid) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.debit_and_enqueue_anchor(uuid, uuid, integer, text, anchor_status, anchor_status) IS
  'SCRUM-2350 QUEUE-04: atomically debit one org credit AND transition an anchor '
  'status in a single transaction. reference_id = per-anchor id. Idempotent on '
  'retry (single debit). Insufficient credit leaves the anchor in p_expected_status '
  'with no partial debit. Replaces the non-atomic debit/broadcast/refund saga.';

COMMENT ON FUNCTION public.org_credit_ledger_divergence(uuid, integer) IS
  'SCRUM-2349: money-conservation reconciliation. balance == p_initial_grant + '
  'SUM(org_credit_deductions.amount). Daily divergence alarm queries WHERE diverged.';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ROLLBACK:
-- BEGIN;
--   -- Restore pre-0341 function bodies (positive DEBIT amount, DELETE-on-refund):
--   --   deduct_org_credit  -> body from 0326_scrum1649_deduct_org_credit_idempotency.sql
--   --   refund_org_credit  -> body from 0326 (DELETEs the idempotency row)
--   --   deduct_credit      -> body from 00000000000000_baseline_at_main_HEAD.sql (no idempotent replay)
--   DROP FUNCTION IF EXISTS public.debit_and_enqueue_anchor(uuid, uuid, integer, text, anchor_status, anchor_status);
--   DROP FUNCTION IF EXISTS public.org_credit_ledger_divergence(uuid, integer);
--   DROP INDEX IF EXISTS public.uq_credit_transactions_user_reference_type;
--   DROP TRIGGER IF EXISTS trg_org_credit_deductions_append_only ON public.org_credit_deductions;
--   DROP FUNCTION IF EXISTS public.reject_org_credit_deduction_mutation();
--   GRANT DELETE ON TABLE public.org_credit_deductions TO service_role;
--   ALTER TABLE public.org_credit_deductions
--     DROP CONSTRAINT IF EXISTS org_credit_deductions_amount_signed_check,
--     DROP CONSTRAINT IF EXISTS org_credit_deductions_entry_type_check,
--     DROP CONSTRAINT IF EXISTS org_credit_deductions_balance_after_nonneg_check;
--   -- Re-negate debit rows back to positive before re-adding the unsigned CHECK:
--   UPDATE public.org_credit_deductions SET amount = -amount WHERE entry_type = 'DEBIT' AND amount < 0;
--   ALTER TABLE public.org_credit_deductions
--     ADD CONSTRAINT org_credit_deductions_amount_check CHECK (amount > 0),
--     ADD CONSTRAINT org_credit_deductions_balance_after_check CHECK (balance_after >= 0);
--   ALTER TABLE public.org_credit_deductions DROP COLUMN IF EXISTS entry_type;
--   NOTIFY pgrst, 'reload schema';
-- COMMIT;
