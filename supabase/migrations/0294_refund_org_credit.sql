BEGIN;

-- Atomic service-role refund companion for deduct_org_credit().
CREATE OR REPLACE FUNCTION refund_org_credit(
  p_org_id       uuid,
  p_amount       integer,
  p_reason       text DEFAULT 'anchor.refund',
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

  RETURN jsonb_build_object(
    'success', true,
    'balance', v_balance,
    'refunded', p_amount,
    'reason', p_reason,
    'reference_id', p_reference_id
  );
END;
$$;

REVOKE ALL ON FUNCTION refund_org_credit(uuid, integer, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refund_org_credit(uuid, integer, text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ROLLBACK:
-- DROP FUNCTION IF EXISTS refund_org_credit(uuid, integer, text, uuid);
