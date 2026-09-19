-- SCRUM-5212: let an explicitly resubmitted, never-debited NEEDS_CREDIT
-- instant intent resume after its exact personal/org pool receives credit.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.anchor_instant_intents
  ADD COLUMN rearm_generation integer NOT NULL DEFAULT 0
  CONSTRAINT anchor_instant_intents_rearm_generation_nonnegative CHECK (rearm_generation >= 0);

CREATE OR REPLACE FUNCTION public.retry_anchor_instant_intent(
  p_anchor_id uuid,
  p_user_id uuid,
  p_org_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET statement_timeout TO '15s' AS $$
DECLARE
  v_intent public.anchor_instant_intents%ROWTYPE;
  v_job_id uuid;
  v_balance integer;
  v_generation integer;
BEGIN
  IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role_required' USING ERRCODE = '42501';
  END IF;

  -- Match claim_anchor_instant_intent's intent -> anchor -> credit lock order.
  SELECT * INTO v_intent FROM public.anchor_instant_intents
    WHERE anchor_id = p_anchor_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'intent_not_found');
  END IF;

  PERFORM 1 FROM public.anchors a
    WHERE a.id = v_intent.anchor_id AND a.user_id = p_user_id
      AND v_intent.user_id = p_user_id
      AND a.org_id IS NOT DISTINCT FROM p_org_id
      AND v_intent.org_id IS NOT DISTINCT FROM p_org_id
      AND a.status = 'PENDING' AND a.deleted_at IS NULL
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'anchor_not_queued');
  END IF;

  IF v_intent.status <> 'NEEDS_CREDIT' THEN
    RETURN jsonb_build_object('success', true, 'intent_id', v_intent.id,
      'status', v_intent.status, 'idempotent', true);
  END IF;

  IF v_intent.attempt <> 0 OR v_intent.debit_reason IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.credit_transactions t
       WHERE t.user_id = v_intent.user_id AND t.reference_id = v_intent.anchor_id
         AND t.transaction_type = 'DEDUCTION')
     OR EXISTS (SELECT 1 FROM public.org_credit_deductions d
       WHERE d.org_id = v_intent.org_id AND d.reference_id = v_intent.anchor_id
         AND d.entry_type = 'DEBIT') THEN
    RETURN jsonb_build_object('success', false, 'error', 'intent_not_retryable');
  END IF;

  IF v_intent.org_id IS NULL THEN
    SELECT balance INTO v_balance FROM public.credits
      WHERE user_id = v_intent.user_id FOR UPDATE;
  ELSE
    SELECT balance INTO v_balance FROM public.org_credits
      WHERE org_id = v_intent.org_id FOR UPDATE;
  END IF;
  IF COALESCE(v_balance, 0) < 1 THEN
    RETURN jsonb_build_object('success', true, 'intent_id', v_intent.id,
      'status', 'NEEDS_CREDIT', 'idempotent', true);
  END IF;

  v_generation := v_intent.rearm_generation + 1;
  UPDATE public.anchor_instant_intents SET status = 'QUEUED',
    rearm_generation = v_generation, last_error_code = NULL, updated_at = now()
    WHERE id = v_intent.id AND status = 'NEEDS_CREDIT' AND attempt = 0
      AND debit_reason IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'intent_not_retryable');
  END IF;

  v_job_id := gen_random_uuid();
  -- job-queue-producer: anchor.instant_secure
  INSERT INTO public.job_queue(id, type, payload, priority, max_attempts, status, attempts)
    VALUES (v_job_id, 'anchor.instant_secure',
      jsonb_build_object('intent_id', v_intent.id, 'generation', v_generation),
      100, 10, 'pending', 0);
  RETURN jsonb_build_object('success', true, 'intent_id', v_intent.id,
    'job_id', v_job_id, 'status', 'QUEUED', 'generation', v_generation,
    'idempotent', false);
END;
$$;
REVOKE ALL ON FUNCTION public.retry_anchor_instant_intent(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_anchor_instant_intent(uuid, uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- ROLLBACK: DROP FUNCTION public.retry_anchor_instant_intent(uuid,uuid,uuid);
-- ALTER TABLE public.anchor_instant_intents DROP COLUMN rearm_generation;
