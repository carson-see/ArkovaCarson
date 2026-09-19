-- SCRUM-5139 / UAT-12: preserve the 0349 organization-credit conservation
-- invariant for one-time anchor-credit purchases.
--
-- 0461 increased balance and purchased principal, but also wrote the same
-- quantity as a GRANT in org_credit_deductions. The canonical 0349 reconciler
-- counts purchased principal plus every signed ledger amount, so that purchase
-- was counted twice. Existing rows remain append-only: compensate only an exact
-- receipt-to-ledger match, then omit the duplicate entry for future purchases.
-- Personal purchases are unchanged.
--
-- Emergency rollback only: first disable anchor-credit checkout and Stripe
-- purchase fulfillment, drain in-flight events, then restore the 0461 function
-- inside that disabled-purchase window. The 0461 body double-books organization
-- purchase principal and is never a safe production steady state. Compensating
-- REVOKE rows remain immutable audit history; roll forward to this body and
-- reconcile purchases before re-enabling intake. Never delete audit rows.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Serialize against the 0461 function while its body is replaced and its exact
-- historical receipts are classified. A grant that committed before these
-- locks is included in the scan; a grant that starts afterward waits and then
-- executes the corrected function. Lock in the old function's write order.
LOCK TABLE public.anchor_credit_purchases IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.org_credits IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.org_credit_deductions IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO public.org_credit_deductions(
  org_id, reference_id, reason, amount, balance_after, entry_type
)
SELECT d.org_id, d.reference_id,
  'anchor.credit_purchase.principal_reclassification',
  -p.quantity, oc.balance, 'REVOKE'
FROM public.org_credit_deductions d
JOIN public.anchor_credit_purchases p
  ON p.id = d.reference_id
 AND p.target_org_id IS NOT NULL
 AND d.org_id = p.target_org_id
JOIN public.org_credits oc ON oc.org_id = d.org_id
WHERE d.reason = 'anchor.credit_purchase'
  AND d.entry_type = 'GRANT'
  AND d.amount = p.quantity
ON CONFLICT (org_id, reference_id, reason) DO NOTHING;

CREATE OR REPLACE FUNCTION public.grant_purchased_anchor_credits(
  p_stripe_event_id text, p_stripe_session_id text,
  p_purchaser_user_id uuid, p_target_user_id uuid, p_target_org_id uuid,
  p_quantity integer, p_amount_paid_cents integer, p_currency text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_purchase public.anchor_credit_purchases%ROWTYPE;
  v_balance integer;
BEGIN
  IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE = '42501'; END IF;
  IF p_stripe_event_id IS NULL OR p_stripe_session_id IS NULL OR p_purchaser_user_id IS NULL
     OR p_quantity IS NULL OR p_amount_paid_cents IS NULL OR p_currency IS NULL
     OR p_quantity NOT BETWEEN 1 AND 1000 OR p_amount_paid_cents <> p_quantity * 200
     OR lower(p_currency) <> 'usd'
     OR (p_target_user_id IS NOT NULL AND p_target_user_id <> p_purchaser_user_id)
     OR ((p_target_user_id IS NULL) = (p_target_org_id IS NULL)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_purchase');
  END IF;

  INSERT INTO public.anchor_credit_purchases(
    stripe_event_id, stripe_session_id, purchaser_user_id, target_user_id,
    target_org_id, quantity, amount_paid_cents, currency
  ) VALUES (
    p_stripe_event_id, p_stripe_session_id, p_purchaser_user_id,
    p_target_user_id, p_target_org_id, p_quantity, p_amount_paid_cents, lower(p_currency)
  ) ON CONFLICT DO NOTHING RETURNING * INTO v_purchase;

  IF NOT FOUND THEN
    SELECT * INTO v_purchase FROM public.anchor_credit_purchases
      WHERE stripe_event_id = p_stripe_event_id OR stripe_session_id = p_stripe_session_id
      FOR UPDATE;
    IF NOT FOUND OR v_purchase.stripe_event_id <> p_stripe_event_id
       OR v_purchase.stripe_session_id <> p_stripe_session_id
       OR v_purchase.purchaser_user_id <> p_purchaser_user_id
       OR v_purchase.target_user_id IS DISTINCT FROM p_target_user_id
       OR v_purchase.target_org_id IS DISTINCT FROM p_target_org_id
       OR v_purchase.quantity <> p_quantity
       OR v_purchase.amount_paid_cents <> p_amount_paid_cents THEN
      RETURN jsonb_build_object('success', false, 'error', 'purchase_idempotency_conflict');
    END IF;
    RETURN jsonb_build_object('success', true, 'idempotent', true, 'purchase_id', v_purchase.id);
  END IF;

  IF p_target_org_id IS NOT NULL THEN
    INSERT INTO public.org_credits(org_id, balance, purchased)
      VALUES (p_target_org_id, p_quantity, p_quantity)
      ON CONFLICT (org_id) DO UPDATE SET
        balance = public.org_credits.balance + EXCLUDED.balance,
        purchased = public.org_credits.purchased + EXCLUDED.purchased,
        updated_at = now()
      RETURNING balance INTO v_balance;
    -- 0349 already counts purchased principal from org_credits.purchased.
  ELSE
    INSERT INTO public.credits(user_id, balance, purchased)
      VALUES (p_target_user_id, p_quantity, p_quantity)
      ON CONFLICT (user_id) DO UPDATE SET
        balance = public.credits.balance + EXCLUDED.balance,
        purchased = public.credits.purchased + EXCLUDED.purchased,
        updated_at = now()
      RETURNING balance INTO v_balance;
    INSERT INTO public.credit_transactions(user_id, transaction_type, amount, balance_after, reason, reference_id)
      VALUES (p_target_user_id, 'PURCHASE', p_quantity, v_balance, 'anchor.credit_purchase', v_purchase.id);
  END IF;

  RETURN jsonb_build_object('success', true, 'idempotent', false,
    'purchase_id', v_purchase.id, 'balance', v_balance, 'granted', p_quantity);
END;
$$;

REVOKE ALL ON FUNCTION public.grant_purchased_anchor_credits(text, text, uuid, uuid, uuid, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_purchased_anchor_credits(text, text, uuid, uuid, uuid, integer, integer, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
