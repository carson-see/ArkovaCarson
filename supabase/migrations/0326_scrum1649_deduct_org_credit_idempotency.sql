BEGIN;

-- SCRUM-1649: make org-credit deduction retry-safe for rule executions.
-- A FAST_TRACK_ANCHOR retry uses organization_rule_executions.id as
-- p_reference_id; the deduction must be charged once even if the worker
-- crashes after the RPC succeeds but before execution finalization persists.
CREATE TABLE IF NOT EXISTS public.org_credit_deductions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  reference_id uuid NOT NULL,
  reason text NOT NULL,
  amount integer NOT NULL CHECK (amount > 0),
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, reference_id, reason)
);

ALTER TABLE public.org_credit_deductions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_credit_deductions FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.org_credit_deductions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.org_credit_deductions TO service_role;

DROP POLICY IF EXISTS org_credit_deductions_service_all ON public.org_credit_deductions;
CREATE POLICY org_credit_deductions_service_all
  ON public.org_credit_deductions
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.org_credit_deductions IS
  'Idempotency ledger for org-credit deductions keyed by org, reference_id, and reason.';

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

  SELECT balance INTO v_balance
  FROM org_credits
  WHERE org_id = p_org_id
  FOR UPDATE;

  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'org_not_initialized');
  END IF;

  IF p_reference_id IS NOT NULL THEN
    SELECT * INTO v_existing
    FROM org_credit_deductions
    WHERE org_id = p_org_id
      AND reference_id = p_reference_id
      AND reason = p_reason;

    IF FOUND THEN
      IF v_existing.amount <> p_amount THEN
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

  IF p_reference_id IS NOT NULL THEN
    INSERT INTO org_credit_deductions (org_id, reference_id, reason, amount, balance_after)
    VALUES (p_org_id, p_reference_id, p_reason, p_amount, v_balance);
  END IF;

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
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
  END IF;

  UPDATE org_credits
  SET balance = balance + p_amount,
      updated_at = now()
  WHERE org_id = p_org_id
  RETURNING balance INTO v_balance;

  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'org_not_initialized');
  END IF;

  IF p_reference_id IS NOT NULL THEN
    DELETE FROM org_credit_deductions
    WHERE org_id = p_org_id
      AND reference_id = p_reference_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'balance', v_balance,
    'refunded', p_amount,
    'reason', p_reason,
    'reference_id', p_reference_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.deduct_org_credit(uuid, integer, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.deduct_org_credit(uuid, integer, text, uuid) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.refund_org_credit(uuid, integer, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_org_credit(uuid, integer, text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ROLLBACK:
-- CREATE OR REPLACE FUNCTION public.deduct_org_credit(uuid, integer, text, uuid) with the pre-0326 body from 00000000000000_baseline_at_main_HEAD.sql.
-- CREATE OR REPLACE FUNCTION public.refund_org_credit(uuid, integer, text, uuid) with the pre-0326 body from 0296_refund_org_credit.sql.
-- DROP TABLE IF EXISTS public.org_credit_deductions;
