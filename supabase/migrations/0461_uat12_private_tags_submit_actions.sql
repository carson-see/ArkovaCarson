BEGIN;

-- Hot-table DDL below creates a trigger on anchors. Bound the metadata lock so
-- this migration cannot become a lock-queue barrier behind a long reader.
SET LOCAL lock_timeout = '5s';

-- SCRUM-5139: private, reusable user/org tags. Tags never share the public
-- anchors.metadata projection. Exact-org policies deliberately do not inherit
-- visibility from a parent organization.
CREATE TABLE public.anchor_private_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_id uuid NOT NULL REFERENCES public.anchors(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('user', 'organization')),
  tag text NOT NULL CHECK (char_length(btrim(tag)) BETWEEN 1 AND 64),
  normalized_tag text GENERATED ALWAYS AS (lower(btrim(tag))) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT anchor_private_tags_scope_shape CHECK (
    (scope = 'user' AND org_id IS NULL)
    OR (scope = 'organization' AND org_id IS NOT NULL)
  )
);
ALTER TABLE public.anchor_private_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anchor_private_tags FORCE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX anchor_private_tags_user_unique
  ON public.anchor_private_tags(anchor_id, owner_user_id, normalized_tag) WHERE scope = 'user';
CREATE UNIQUE INDEX anchor_private_tags_org_unique
  ON public.anchor_private_tags(anchor_id, org_id, normalized_tag) WHERE scope = 'organization';
CREATE INDEX anchor_private_tags_user_suggestions ON public.anchor_private_tags(owner_user_id, normalized_tag);
CREATE INDEX anchor_private_tags_org_suggestions ON public.anchor_private_tags(org_id, normalized_tag) WHERE scope = 'organization';
CREATE POLICY anchor_private_tags_select ON public.anchor_private_tags
  FOR SELECT TO authenticated USING (
    (scope = 'user' AND owner_user_id = (SELECT auth.uid()))
    OR (scope = 'organization' AND org_id IN (SELECT public.get_user_org_ids()))
  );
CREATE POLICY anchor_private_tags_insert ON public.anchor_private_tags
  FOR INSERT TO authenticated WITH CHECK (
    owner_user_id = (SELECT auth.uid())
    AND ((scope = 'user' AND org_id IS NULL)
      OR (scope = 'organization' AND org_id IN (SELECT public.get_user_org_ids())))
    AND EXISTS (
      SELECT 1 FROM public.anchors a
      WHERE a.id = anchor_private_tags.anchor_id
        AND a.user_id = (SELECT auth.uid())
        AND (anchor_private_tags.org_id IS NULL OR a.org_id = anchor_private_tags.org_id)
    )
  );
CREATE POLICY anchor_private_tags_mfa ON public.anchor_private_tags
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (private.is_human_mfa_verified()) WITH CHECK (private.is_human_mfa_verified());
CREATE POLICY anchor_private_tags_service_all ON public.anchor_private_tags
  FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON public.anchor_private_tags TO authenticated;
GRANT ALL ON public.anchor_private_tags TO service_role;

-- Durable application intent. The existing anchor_txid_journal remains the
-- authority once signing begins; this table owns request/credit/job state only.
CREATE TABLE public.anchor_instant_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_id uuid NOT NULL UNIQUE REFERENCES public.anchors(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  org_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN (
    'QUEUED', 'PROCESSING', 'NEEDS_CREDIT', 'RETRYABLE', 'HELD', 'SUBMITTED', 'FAILED'
  )),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  debit_reason text,
  last_error_code text CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.anchor_instant_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anchor_instant_intents FORCE ROW LEVEL SECURITY;
CREATE INDEX anchor_instant_intents_reconcile_idx
  ON public.anchor_instant_intents(status, updated_at) WHERE status IN ('HELD', 'PROCESSING', 'RETRYABLE');
CREATE POLICY anchor_instant_intents_service_all ON public.anchor_instant_intents
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.anchor_instant_intents FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.anchor_instant_intents TO service_role;

-- Paid instant-secure credits use the existing personal/org balance tables,
-- but keep a dedicated Stripe receipt so a duplicated event or session cannot
-- grant twice. The target is exactly one user or one organization.
CREATE TABLE public.anchor_credit_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id text NOT NULL UNIQUE,
  stripe_session_id text NOT NULL UNIQUE,
  purchaser_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  target_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  target_org_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  amount_paid_cents integer NOT NULL CHECK (amount_paid_cents = quantity * 200),
  currency text NOT NULL CHECK (currency = 'usd'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT anchor_credit_purchases_target_shape CHECK (
    (target_user_id IS NOT NULL AND target_org_id IS NULL)
    OR (target_user_id IS NULL AND target_org_id IS NOT NULL)
  )
);
ALTER TABLE public.anchor_credit_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anchor_credit_purchases FORCE ROW LEVEL SECURITY;
CREATE POLICY anchor_credit_purchases_service_all ON public.anchor_credit_purchases
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.anchor_credit_purchases FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.anchor_credit_purchases TO service_role;

CREATE OR REPLACE FUNCTION public.grant_purchased_anchor_credits(
  p_stripe_event_id text,
  p_stripe_session_id text,
  p_purchaser_user_id uuid,
  p_target_user_id uuid,
  p_target_org_id uuid,
  p_quantity integer,
  p_amount_paid_cents integer,
  p_currency text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_purchase public.anchor_credit_purchases%ROWTYPE;
  v_balance integer;
BEGIN
  IF (SELECT auth.role()) <> 'service_role' THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE = '42501'; END IF;
  IF p_stripe_event_id IS NULL OR p_stripe_session_id IS NULL OR p_purchaser_user_id IS NULL
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
    INSERT INTO public.org_credit_deductions(org_id, reference_id, reason, amount, balance_after, entry_type)
      VALUES (p_target_org_id, v_purchase.id, 'anchor.credit_purchase', p_quantity, v_balance, 'GRANT');
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

-- The service-role API submits every new UAT-12 record through this RPC.
-- Anchor, private tags, intent, and durable job become visible in one commit.
CREATE OR REPLACE FUNCTION public.create_anchor_submission(
  p_fingerprint text,
  p_public_id text,
  p_user_id uuid,
  p_org_id uuid,
  p_filename text,
  p_file_size bigint,
  p_file_mime text,
  p_credential_type text,
  p_description text,
  p_fingerprint_source text,
  p_metadata jsonb,
  p_user_tags text[] DEFAULT '{}'::text[],
  p_org_tags text[] DEFAULT '{}'::text[],
  p_action text DEFAULT 'queue'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_anchor public.anchors%ROWTYPE;
  v_intent public.anchor_instant_intents%ROWTYPE;
  v_job_id uuid;
  v_tag text;
BEGIN
  IF (SELECT auth.role()) <> 'service_role' THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE = '42501'; END IF;
  IF p_action NOT IN ('queue', 'instant') OR p_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_user_id IS NULL OR p_public_id IS NULL OR p_filename IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_request');
  END IF;
  IF cardinality(p_org_tags) > 0 AND p_org_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'organization_required');
  END IF;

  INSERT INTO public.anchors(
    fingerprint, public_id, status, org_id, user_id, filename, file_size, file_mime,
    credential_type, description, fingerprint_source, metadata
  ) VALUES (
    p_fingerprint, p_public_id, 'PENDING', p_org_id, p_user_id, p_filename, p_file_size, p_file_mime,
    p_credential_type::public.credential_type, p_description,
    CASE WHEN p_fingerprint_source = 'document_bytes' THEN 'document_bytes' ELSE NULL END,
    COALESCE(p_metadata, '{}'::jsonb)
  ) RETURNING * INTO v_anchor;

  FOREACH v_tag IN ARRAY p_user_tags LOOP
    INSERT INTO public.anchor_private_tags(anchor_id, owner_user_id, org_id, scope, tag)
      VALUES (v_anchor.id, p_user_id, NULL, 'user', v_tag);
  END LOOP;
  FOREACH v_tag IN ARRAY p_org_tags LOOP
    INSERT INTO public.anchor_private_tags(anchor_id, owner_user_id, org_id, scope, tag)
      VALUES (v_anchor.id, p_user_id, p_org_id, 'organization', v_tag);
  END LOOP;

  IF p_action = 'instant' THEN
    INSERT INTO public.anchor_instant_intents(anchor_id, user_id, org_id)
      VALUES (v_anchor.id, p_user_id, p_org_id) RETURNING * INTO v_intent;
    -- job-queue-producer: anchor.instant_secure
    INSERT INTO public.job_queue(type, payload, priority, max_attempts, status, attempts)
      VALUES ('anchor.instant_secure', jsonb_build_object('intent_id', v_intent.id), 100, 10, 'pending', 0)
      RETURNING id INTO v_job_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'id', v_anchor.id, 'public_id', v_anchor.public_id,
    'fingerprint', v_anchor.fingerprint, 'status', v_anchor.status,
    'created_at', v_anchor.created_at, 'credential_type', v_anchor.credential_type,
    'metadata', v_anchor.metadata, 'intent_id', v_intent.id, 'job_id', v_job_id
  );
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', false, 'error', 'duplicate');
END;
$$;
REVOKE ALL ON FUNCTION public.create_anchor_submission(text, text, uuid, uuid, text, bigint, text, text, text, text, jsonb, text[], text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_anchor_submission(text, text, uuid, uuid, text, bigint, text, text, text, text, jsonb, text[], text[], text) TO service_role;

-- Upgrade an existing caller-owned queued anchor to an instant intent.
-- Used by idempotent resubmission and the browser's existing-anchor action.
CREATE OR REPLACE FUNCTION public.enqueue_existing_anchor_instant_intent(
  p_anchor_id uuid,
  p_user_id uuid,
  p_org_id uuid,
  p_user_tags text[] DEFAULT '{}'::text[],
  p_org_tags text[] DEFAULT '{}'::text[]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_intent public.anchor_instant_intents%ROWTYPE;
  v_job_id uuid;
  v_tag text;
BEGIN
  IF (SELECT auth.role()) <> 'service_role' THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE = '42501'; END IF;
  IF cardinality(p_org_tags) > 0 AND p_org_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'organization_required'); END IF;
  PERFORM 1 FROM public.anchors a WHERE a.id = p_anchor_id AND a.user_id = p_user_id
    AND a.org_id IS NOT DISTINCT FROM p_org_id AND a.status = 'PENDING' AND a.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'anchor_not_queued'); END IF;
  SELECT * INTO v_intent FROM public.anchor_instant_intents WHERE anchor_id = p_anchor_id;
  IF FOUND THEN RETURN jsonb_build_object('success', true, 'intent_id', v_intent.id, 'status', v_intent.status, 'idempotent', true); END IF;
  FOREACH v_tag IN ARRAY p_user_tags LOOP
    INSERT INTO public.anchor_private_tags(anchor_id, owner_user_id, org_id, scope, tag)
      VALUES (p_anchor_id, p_user_id, NULL, 'user', v_tag) ON CONFLICT DO NOTHING;
  END LOOP;
  FOREACH v_tag IN ARRAY p_org_tags LOOP
    INSERT INTO public.anchor_private_tags(anchor_id, owner_user_id, org_id, scope, tag)
      VALUES (p_anchor_id, p_user_id, p_org_id, 'organization', v_tag) ON CONFLICT DO NOTHING;
  END LOOP;
  INSERT INTO public.anchor_instant_intents(anchor_id, user_id, org_id)
    VALUES (p_anchor_id, p_user_id, p_org_id) RETURNING * INTO v_intent;
  -- job-queue-producer: anchor.instant_secure
  INSERT INTO public.job_queue(type, payload, priority, max_attempts, status, attempts)
    VALUES ('anchor.instant_secure', jsonb_build_object('intent_id', v_intent.id), 100, 10, 'pending', 0)
    RETURNING id INTO v_job_id;
  RETURN jsonb_build_object('success', true, 'intent_id', v_intent.id, 'job_id', v_job_id, 'status', 'QUEUED', 'idempotent', false);
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_existing_anchor_instant_intent(uuid, uuid, uuid, text[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_existing_anchor_instant_intent(uuid, uuid, uuid, text[], text[]) TO service_role;

-- Exact claim + exact source debit in one transaction. The attempt is persisted
-- for stale-worker settlement rejection; a safely refunded intent is terminal
-- because the canonical personal ledger permits one deduction/refund per anchor.
CREATE OR REPLACE FUNCTION public.claim_anchor_instant_intent(
  p_intent_id uuid,
  p_worker_id text
) RETURNS TABLE(
  id uuid, user_id uuid, org_id uuid, fingerprint text, public_id text,
  metadata jsonb, credential_type text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET statement_timeout TO '15s' AS $$
DECLARE
  v_intent public.anchor_instant_intents%ROWTYPE;
  v_attempt integer;
  v_reason text;
  v_balance integer;
  v_org_result jsonb;
BEGIN
  IF (SELECT auth.role()) <> 'service_role' THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_intent FROM public.anchor_instant_intents WHERE anchor_instant_intents.id = p_intent_id FOR UPDATE;
  IF NOT FOUND OR v_intent.status NOT IN ('QUEUED', 'RETRYABLE') THEN RETURN; END IF;
  PERFORM 1 FROM public.anchors a WHERE a.id = v_intent.anchor_id
    AND a.user_id = v_intent.user_id AND a.org_id IS NOT DISTINCT FROM v_intent.org_id
    AND a.status = 'PENDING' AND a.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    UPDATE public.anchor_instant_intents SET status = 'FAILED', last_error_code = 'anchor_not_claimable', updated_at = now()
      WHERE anchor_instant_intents.id = p_intent_id;
    RETURN;
  END IF;
  v_attempt := v_intent.attempt + 1;
  v_reason := 'anchor.instant.' || v_intent.id::text || '.' || v_attempt::text;
  PERFORM set_config('app.instant_intent_claim', v_intent.id::text || ':' || v_attempt::text, true);

  IF v_intent.org_id IS NOT NULL THEN
    v_org_result := public.debit_and_enqueue_anchor(
      v_intent.org_id, v_intent.anchor_id, 1, v_reason, 'BROADCASTING', 'PENDING'
    );
    IF NOT COALESCE((v_org_result->>'success')::boolean, false) THEN
      UPDATE public.anchor_instant_intents SET
        status = CASE WHEN v_org_result->>'error' = 'insufficient_credits' THEN 'NEEDS_CREDIT' ELSE 'RETRYABLE' END,
        last_error_code = COALESCE(v_org_result->>'error', 'credit_check_unavailable'), updated_at = now()
      WHERE anchor_instant_intents.id = p_intent_id;
      RETURN;
    END IF;
  ELSE
    SELECT c.balance INTO v_balance FROM public.credits c WHERE c.user_id = v_intent.user_id FOR UPDATE;
    IF v_balance IS NULL OR v_balance < 1 THEN
      UPDATE public.anchor_instant_intents SET status = 'NEEDS_CREDIT', last_error_code = 'insufficient_credits', updated_at = now()
      WHERE anchor_instant_intents.id = p_intent_id;
      RETURN;
    END IF;
    UPDATE public.anchors a SET status = 'BROADCASTING', updated_at = now(),
      metadata = jsonb_set(COALESCE(a.metadata, '{}'::jsonb), '{_claimed_by}', to_jsonb(p_worker_id))
        || jsonb_build_object('_claimed_at', to_jsonb(now()::text), '_instant_intent_id', to_jsonb(p_intent_id::text))
    WHERE a.id = v_intent.anchor_id AND a.user_id = v_intent.user_id AND a.org_id IS NULL AND a.status = 'PENDING' AND a.deleted_at IS NULL;
    IF NOT FOUND THEN RETURN; END IF;
    UPDATE public.credits SET balance = balance - 1, updated_at = now()
      WHERE credits.user_id = v_intent.user_id RETURNING balance INTO v_balance;
    INSERT INTO public.credit_transactions(user_id, transaction_type, amount, balance_after, reason, reference_id)
      VALUES (v_intent.user_id, 'DEDUCTION', -1, v_balance, v_reason, v_intent.anchor_id);
  END IF;

  -- Org helper stamped its own status; add exact intent claim metadata to both paths.
  UPDATE public.anchors a SET metadata = jsonb_set(COALESCE(a.metadata, '{}'::jsonb), '{_claimed_by}', to_jsonb(p_worker_id))
      || jsonb_build_object('_claimed_at', to_jsonb(now()::text), '_instant_intent_id', to_jsonb(p_intent_id::text))
    WHERE a.id = v_intent.anchor_id AND a.status = 'BROADCASTING';
  UPDATE public.anchor_instant_intents SET status = 'PROCESSING', attempt = v_attempt,
    debit_reason = v_reason, last_error_code = NULL, updated_at = now()
    WHERE anchor_instant_intents.id = p_intent_id;

  RETURN QUERY SELECT a.id, a.user_id, a.org_id, a.fingerprint::text, a.public_id,
    a.metadata, a.credential_type::text FROM public.anchors a WHERE a.id = v_intent.anchor_id;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_anchor_instant_intent(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_anchor_instant_intent(uuid, text) TO service_role;

-- Persisted evidence decides settlement. RETRYABLE is legal only when the
-- anchor is back at PENDING, has no tx id, and no unresolved txid journal names
-- it. Refund also proves a matching one-credit debit before adding balance.
CREATE OR REPLACE FUNCTION public.settle_anchor_instant_intent(
  p_intent_id uuid,
  p_outcome text,
  p_expected_attempt integer,
  p_error_code text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_intent public.anchor_instant_intents%ROWTYPE;
  v_anchor public.anchors%ROWTYPE;
  v_balance integer;
  v_refund_reason text;
BEGIN
  IF (SELECT auth.role()) <> 'service_role' THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_intent FROM public.anchor_instant_intents WHERE id = p_intent_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'intent_not_found'); END IF;
  IF v_intent.attempt <> p_expected_attempt THEN
    RETURN jsonb_build_object('success', false, 'error', 'stale_attempt');
  END IF;
  SELECT * INTO v_anchor FROM public.anchors WHERE id = v_intent.anchor_id FOR UPDATE;

  IF p_outcome = 'SUBMITTED' THEN
    IF v_anchor.status NOT IN ('SUBMITTED', 'SECURED') THEN RETURN jsonb_build_object('success', false, 'error', 'anchor_not_submitted'); END IF;
    IF v_intent.status = 'SUBMITTED' THEN
      RETURN jsonb_build_object('success', true, 'status', 'SUBMITTED', 'idempotent', true);
    END IF;
    IF v_intent.status NOT IN ('PROCESSING', 'HELD') THEN
      RETURN jsonb_build_object('success', false, 'error', 'stale_attempt');
    END IF;
    UPDATE public.anchor_instant_intents SET status = 'SUBMITTED', last_error_code = NULL, updated_at = now() WHERE id = p_intent_id;
    RETURN jsonb_build_object('success', true, 'status', 'SUBMITTED');
  ELSIF p_outcome = 'FAILED_SAFE' AND v_intent.status = 'FAILED' THEN
    RETURN jsonb_build_object('success', true, 'status', 'FAILED', 'refunded', 0, 'idempotent', true);
  ELSIF v_intent.status <> 'PROCESSING' THEN
    RETURN jsonb_build_object('success', false, 'error', 'stale_attempt');
  ELSIF p_outcome = 'HELD' THEN
    IF v_anchor.status <> 'BROADCASTING' AND v_anchor.chain_tx_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'no_ambiguous_evidence'); END IF;
    UPDATE public.anchor_instant_intents SET status = 'HELD', last_error_code = left(COALESCE(p_error_code, 'broadcast_ambiguous'), 100), updated_at = now() WHERE id = p_intent_id;
    RETURN jsonb_build_object('success', true, 'status', 'HELD');
  ELSIF p_outcome <> 'FAILED_SAFE' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_outcome');
  END IF;

  IF v_intent.debit_reason IS NULL OR v_anchor.status <> 'PENDING' OR v_anchor.chain_tx_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.anchor_txid_journal j WHERE v_intent.anchor_id = ANY(j.anchor_ids) AND j.recovery_status IN ('PENDING', 'HELD')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'prebroadcast_absence_not_proven');
  END IF;
  v_refund_reason := v_intent.debit_reason || '.refund';

  IF v_intent.org_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.org_credit_deductions d WHERE d.org_id = v_intent.org_id
      AND d.reference_id = v_intent.anchor_id AND d.reason = v_intent.debit_reason AND d.entry_type = 'DEBIT' AND d.amount = -1) THEN
      RETURN jsonb_build_object('success', false, 'error', 'matching_debit_not_found');
    END IF;
    SELECT balance INTO v_balance FROM public.org_credits WHERE org_id = v_intent.org_id FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM public.org_credit_deductions d WHERE d.org_id = v_intent.org_id
      AND d.reference_id = v_intent.anchor_id AND d.reason = v_refund_reason AND d.entry_type = 'REFUND') THEN
      UPDATE public.org_credits SET balance = balance + 1, updated_at = now() WHERE org_id = v_intent.org_id RETURNING balance INTO v_balance;
      INSERT INTO public.org_credit_deductions(org_id, reference_id, reason, amount, balance_after, entry_type)
        VALUES (v_intent.org_id, v_intent.anchor_id, v_refund_reason, 1, v_balance, 'REFUND');
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.credit_transactions t WHERE t.user_id = v_intent.user_id
      AND t.reference_id = v_intent.anchor_id AND t.reason = v_intent.debit_reason AND t.transaction_type = 'DEDUCTION' AND t.amount = -1) THEN
      RETURN jsonb_build_object('success', false, 'error', 'matching_debit_not_found');
    END IF;
    SELECT balance INTO v_balance FROM public.credits WHERE user_id = v_intent.user_id FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM public.credit_transactions t WHERE t.user_id = v_intent.user_id
      AND t.reference_id = v_intent.anchor_id AND t.reason = v_refund_reason AND t.transaction_type = 'REFUND') THEN
      UPDATE public.credits SET balance = balance + 1, updated_at = now() WHERE user_id = v_intent.user_id RETURNING balance INTO v_balance;
      INSERT INTO public.credit_transactions(user_id, transaction_type, amount, balance_after, reason, reference_id)
        VALUES (v_intent.user_id, 'REFUND', 1, v_balance, v_refund_reason, v_intent.anchor_id);
    END IF;
  END IF;

  UPDATE public.anchor_instant_intents SET status = 'FAILED', last_error_code = left(COALESCE(p_error_code, 'prebroadcast_failure'), 100), updated_at = now() WHERE id = p_intent_id;
  RETURN jsonb_build_object('success', true, 'status', 'FAILED', 'refunded', 1);
END;
$$;
REVOKE ALL ON FUNCTION public.settle_anchor_instant_intent(uuid, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_anchor_instant_intent(uuid, text, integer, text) TO service_role;

-- Preserve the canonical claim shape and add only the anti-starvation
-- predicate. The trigger below remains the residual publication-race guard.
CREATE OR REPLACE FUNCTION public.claim_pending_anchors(
  p_worker_id text DEFAULT 'worker-1', p_limit integer DEFAULT 50,
  p_exclude_pipeline boolean DEFAULT true, p_org_id uuid DEFAULT NULL
) RETURNS TABLE(id uuid, user_id uuid, org_id uuid, fingerprint text, public_id text, metadata jsonb, credential_type text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET statement_timeout TO '60s' AS $$
BEGIN
  RETURN QUERY WITH claimed AS (
    UPDATE public.anchors a SET status = 'BROADCASTING', updated_at = now(),
      metadata = jsonb_set(COALESCE(a.metadata, '{}'::jsonb), '{_claimed_by}', to_jsonb(p_worker_id))
        || jsonb_build_object('_claimed_at', to_jsonb(now()::text))
    WHERE a.id IN (
      SELECT a2.id FROM public.anchors a2
      WHERE a2.status = 'PENDING' AND a2.deleted_at IS NULL
        AND (p_org_id IS NULL OR a2.org_id = p_org_id)
        AND (NOT p_exclude_pipeline OR (a2.metadata->>'pipeline_source') IS NULL)
        AND NOT EXISTS (SELECT 1 FROM public.anchor_instant_intents i
          WHERE i.anchor_id = a2.id AND i.status IN ('QUEUED','PROCESSING','NEEDS_CREDIT','RETRYABLE','HELD'))
      ORDER BY a2.created_at ASC FOR UPDATE SKIP LOCKED
      LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 0), 10000)
    ) RETURNING a.*
  )
  SELECT claimed.id, claimed.user_id, claimed.org_id, claimed.fingerprint::text,
    claimed.public_id, claimed.metadata, claimed.credential_type::text FROM claimed;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_pending_anchors(text, integer, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pending_anchors(text, integer, boolean, uuid) TO service_role;

-- The canonical ordinary batch claim remains unchanged. This narrow trigger
-- prevents it from winning a PENDING -> BROADCASTING race for an active instant
-- intent. The exact claim RPC sets a transaction-local intent id before calling
-- debit_and_enqueue_anchor; every other worker's transition is skipped.
CREATE OR REPLACE FUNCTION public.guard_active_instant_anchor_claim()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_intent_id uuid; v_attempt integer;
BEGIN
  IF OLD.status = 'PENDING' AND NEW.status = 'BROADCASTING' THEN
    SELECT i.id, i.attempt + 1 INTO v_intent_id, v_attempt FROM public.anchor_instant_intents i
      WHERE i.anchor_id = NEW.id AND i.status IN ('QUEUED', 'PROCESSING', 'NEEDS_CREDIT', 'RETRYABLE', 'HELD');
    IF FOUND THEN
      IF COALESCE((SELECT auth.role()), '') <> 'service_role'
         OR COALESCE(current_setting('app.instant_intent_claim', true), '') <> (v_intent_id::text || ':' || v_attempt::text) THEN
        RETURN NULL;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_active_instant_anchor_claim() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER guard_active_instant_anchor_claim
  BEFORE UPDATE OF status ON public.anchors FOR EACH ROW
  EXECUTE FUNCTION public.guard_active_instant_anchor_claim();

-- Preserve 0334's critical internal-key guard while extending its PII denylist.
CREATE OR REPLACE FUNCTION public.sanitize_metadata_for_public(p_metadata jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT COALESCE((
    SELECT jsonb_object_agg(kv.key, kv.value)
    FROM jsonb_each(COALESCE(p_metadata, '{}'::jsonb)
      - 'recipient' - 'email' - 'phone' - 'phone_number' - 'ssn'
      - 'social_security' - 'student_id' - 'student_number' - 'address'
      - 'street_address' - 'home_address' - 'mailing_address' - 'dob'
      - 'date_of_birth' - 'birthday' - 'national_id' - 'passport_number'
      - 'drivers_license' - 'private_tags' - 'user_tags' - 'org_tags') AS kv(key, value)
    WHERE kv.key NOT LIKE '\_%'
  ), '{}'::jsonb);
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- ROLLBACK: drop settle_anchor_instant_intent, claim_anchor_instant_intent,
-- create_anchor_submission, anchor_instant_intents, anchor_private_tags;
-- restore sanitize_metadata_for_public from migration 0334.
