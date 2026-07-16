-- SCRUM-2692: durable pre-broadcast Bitcoin txid journal.
--
-- The signed transaction id is known before broadcast. Persisting the exact
-- txid and claimed cohort first closes the crash window between network
-- acceptance and anchors.chain_tx_id persistence. Recovery is deliberately
-- tri-state: exact tx found -> ADOPT, affirmative bounded absence -> REVERT,
-- every ambiguous outcome -> HOLD. PENDING and HELD cohorts are excluded from
-- the generic stale-BROADCASTING sweep in the same migration.
--
-- Tier: T3 (money path + anchor lifecycle + migration).
-- Forward rehearsal: apply on an isolated clean mirror, exercise all four
-- crash boundaries, then prove rollback and clean re-apply before release.

CREATE TABLE public.anchor_txid_journal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id text NOT NULL,
  txid text NOT NULL,
  fingerprint_root text NOT NULL,
  anchor_ids uuid[] NOT NULL,
  leaf_order jsonb NOT NULL,
  -- Database-authored: recovery age must never trust a worker clock.
  signed_at timestamptz NOT NULL DEFAULT now(),
  recovery_status text NOT NULL DEFAULT 'PENDING',
  hold_reason text,
  held_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT anchor_txid_journal_batch_id_bounded CHECK (char_length(batch_id) BETWEEN 1 AND 200),
  CONSTRAINT anchor_txid_journal_txid_hex CHECK (txid ~ '^[0-9a-f]{64}$'),
  CONSTRAINT anchor_txid_journal_root_hex CHECK (fingerprint_root ~ '^[0-9a-f]{64}$'),
  CONSTRAINT anchor_txid_journal_anchor_ids_nonempty CHECK (cardinality(anchor_ids) BETWEEN 1 AND 10000),
  CONSTRAINT anchor_txid_journal_leaf_order_array CHECK (
    jsonb_typeof(leaf_order) = 'array'
    AND jsonb_array_length(leaf_order) = cardinality(anchor_ids)
  ),
  CONSTRAINT anchor_txid_journal_recovery_status CHECK (
    recovery_status IN ('PENDING', 'HELD', 'ADOPTED', 'REVERTED', 'PERSISTED')
  ),
  CONSTRAINT anchor_txid_journal_resolution_shape CHECK (
    (recovery_status IN ('PENDING', 'HELD') AND resolved_at IS NULL)
    OR (recovery_status IN ('ADOPTED', 'REVERTED', 'PERSISTED') AND resolved_at IS NOT NULL)
  ),
  CONSTRAINT anchor_txid_journal_hold_shape CHECK (
    recovery_status <> 'HELD' OR (held_at IS NOT NULL AND hold_reason IS NOT NULL)
  ),
  CONSTRAINT anchor_txid_journal_hold_reason_bounded CHECK (
    hold_reason IS NULL OR char_length(hold_reason) BETWEEN 1 AND 200
  )
);

CREATE INDEX anchor_txid_journal_unresolved_recovery_idx
  ON public.anchor_txid_journal (recovery_status DESC, updated_at, id)
  WHERE recovery_status IN ('PENDING', 'HELD');

-- Resolved REVERT rows are durable audit history, not a permanent retry ban.
-- A deterministic signer may produce the same txid/batch after affirmative
-- absence; uniqueness therefore applies only while a prior attempt remains
-- live or was actually adopted/persisted.
CREATE UNIQUE INDEX anchor_txid_journal_live_batch_id_unique
  ON public.anchor_txid_journal (batch_id)
  WHERE recovery_status <> 'REVERTED';

CREATE UNIQUE INDEX anchor_txid_journal_live_txid_unique
  ON public.anchor_txid_journal (txid)
  WHERE recovery_status <> 'REVERTED';

ALTER TABLE public.anchor_txid_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anchor_txid_journal FORCE ROW LEVEL SECURITY;

CREATE POLICY anchor_txid_journal_deny_clients
  ON public.anchor_txid_journal
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.anchor_txid_journal FROM PUBLIC;
REVOKE ALL ON TABLE public.anchor_txid_journal FROM anon, authenticated;
REVOKE ALL ON TABLE public.anchor_txid_journal FROM service_role;
GRANT SELECT, DELETE ON TABLE public.anchor_txid_journal TO service_role;

COMMENT ON TABLE public.anchor_txid_journal IS
  'SCRUM-2692 service-role-only pre-broadcast txid/cohort journal. PENDING/HELD rows protect their anchors from generic stale recovery.';

-- Journal creation and terminal lifecycle transitions serialize on the same
-- anchor row locks. This prevents a supersede/revoke from committing between
-- a worker's cohort validation and journal insert (or vice versa).
CREATE OR REPLACE FUNCTION public.persist_anchor_txid_journal(
  p_batch_id text,
  p_txid text,
  p_fingerprint_root text,
  p_anchor_ids uuid[],
  p_leaf_order jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '60s'
AS $$
DECLARE
  v_locked_count integer := 0;
  v_matching_count integer := 0;
  v_exact_count integer := 0;
  v_existing public.anchor_txid_journal%ROWTYPE;
  v_matching_journal_ids uuid[] := ARRAY[]::uuid[];
  v_protected_anchor_ids uuid[] := ARRAY[]::uuid[];
  v_journal_id uuid;
  v_release_anchor_ids uuid[] := ARRAY[]::uuid[];
  v_released_count integer := 0;
  v_refund jsonb;
  v_anchor record;
  v_conflict_reason text;
BEGIN
  -- SECURITY DEFINER does not alter the JWT role GUC read by anchor guards.
  -- This function is executable only by service_role; set the transaction-
  -- local claim so its atomic collision release can update system fields.
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  IF p_anchor_ids IS NULL OR cardinality(p_anchor_ids) NOT BETWEEN 1 AND 10000 THEN
    RAISE check_violation
      USING MESSAGE = 'Txid journal anchor cohort must contain 1..10000 rows';
  END IF;
  IF jsonb_typeof(p_leaf_order) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_leaf_order) <> cardinality(p_anchor_ids) THEN
    RAISE check_violation
      USING MESSAGE = 'Txid journal leaf order must match the anchor cohort size';
  END IF;

  -- Serialize same-batch and same-tx candidates even when their anchor cohorts
  -- are disjoint. Namespaced keys and a fixed batch-then-tx lock order avoid a
  -- unique-index race without coupling unrelated batches.
  PERFORM pg_advisory_xact_lock(hashtextextended('anchor_txid_journal:batch:' || p_batch_id, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('anchor_txid_journal:txid:' || lower(p_txid), 0));

  -- Queue-credit paths lock org_credits before anchors. Preserve that order so
  -- a collision unwind can compensate and release its cohort atomically.
  PERFORM oc.org_id
  FROM public.org_credits oc
  WHERE oc.org_id IN (
    SELECT a.org_id
    FROM public.anchors a
    WHERE a.id = ANY(p_anchor_ids)
      AND a.org_id IS NOT NULL
      AND a.metadata->>'queue_credit_source' = 'org_credits'
      AND jsonb_typeof(a.metadata->'queue_credit_charged_at') = 'string'
  )
  ORDER BY oc.org_id
  FOR UPDATE;

  -- Deterministic lock order prevents deadlocks between overlapping batches.
  PERFORM a.id
  FROM public.anchors a
  WHERE a.id = ANY(p_anchor_ids)
  ORDER BY a.id
  FOR UPDATE;
  GET DIAGNOSTICS v_locked_count = ROW_COUNT;

  IF v_locked_count <> cardinality(p_anchor_ids) THEN
    RAISE check_violation
      USING MESSAGE = format(
        'Txid journal locked %s/%s anchors',
        v_locked_count,
        cardinality(p_anchor_ids)
      );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.anchors a
    WHERE a.id = ANY(p_anchor_ids)
      AND (
        a.deleted_at IS NOT NULL
        OR a.status <> 'BROADCASTING'
        OR a.chain_tx_id IS NOT NULL
      )
  ) THEN
    RAISE check_violation
      USING MESSAGE = 'Txid journal cohort is no longer uniformly unbroadcast BROADCASTING';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(p_anchor_ids) WITH ORDINALITY AS input(anchor_id, ordinal)
    JOIN public.anchors a ON a.id = input.anchor_id
    WHERE (p_leaf_order -> ((input.ordinal - 1)::integer) ->> 'anchor_id')
            IS DISTINCT FROM input.anchor_id::text
       OR lower(p_leaf_order -> ((input.ordinal - 1)::integer) ->> 'fingerprint')
            IS DISTINCT FROM lower(a.fingerprint::text)
  ) THEN
    RAISE check_violation
      USING MESSAGE = 'Txid journal leaf order does not match the locked anchor cohort';
  END IF;

  -- The anchor locks serialize concurrent persistence attempts. Re-read the
  -- live journal set after acquiring them. Any non-REVERTED batch/txid match,
  -- or unresolved overlap with this cohort, belongs to recovery and must never
  -- be returned as fresh authorization to broadcast signed bytes again.
  PERFORM j.id
  FROM public.anchor_txid_journal j
  WHERE j.recovery_status <> 'REVERTED'
    AND (
      j.batch_id = p_batch_id
      OR j.txid = lower(p_txid)
      OR (
        j.recovery_status IN ('PENDING', 'HELD')
        AND j.anchor_ids && p_anchor_ids
      )
  )
  ORDER BY j.created_at, j.id
  FOR UPDATE;
  GET DIAGNOSTICS v_matching_count = ROW_COUNT;

  IF v_matching_count > 0 THEN
    -- Every matching row is already locked above. Capture the complete owner
    -- set before deciding what can be released; LIMIT 1 is unsafe because a
    -- candidate can collide with one journal's batch_id and another's txid.
    SELECT * INTO v_existing
    FROM public.anchor_txid_journal j
    WHERE j.recovery_status <> 'REVERTED'
      AND (
        j.batch_id = p_batch_id
        OR j.txid = lower(p_txid)
        OR (
          j.recovery_status IN ('PENDING', 'HELD')
          AND j.anchor_ids && p_anchor_ids
        )
      )
    ORDER BY j.created_at, j.id
    LIMIT 1;

    SELECT COALESCE(array_agg(j.id ORDER BY j.created_at, j.id), ARRAY[]::uuid[])
    INTO v_matching_journal_ids
    FROM public.anchor_txid_journal j
    WHERE j.recovery_status <> 'REVERTED'
      AND (
        j.batch_id = p_batch_id
        OR j.txid = lower(p_txid)
        OR (
          j.recovery_status IN ('PENDING', 'HELD')
          AND j.anchor_ids && p_anchor_ids
        )
      );

    SELECT COALESCE(
      array_agg(DISTINCT protected.anchor_id ORDER BY protected.anchor_id),
      ARRAY[]::uuid[]
    )
    INTO v_protected_anchor_ids
    FROM public.anchor_txid_journal j
    CROSS JOIN LATERAL unnest(j.anchor_ids) AS protected(anchor_id)
    WHERE j.id = ANY(v_matching_journal_ids)
      AND j.recovery_status IN ('PENDING', 'HELD');

    SELECT count(*)::integer
    INTO v_exact_count
    FROM public.anchor_txid_journal j
    WHERE j.id = ANY(v_matching_journal_ids)
      AND j.recovery_status IN ('PENDING', 'HELD')
      AND j.batch_id = p_batch_id
      AND j.txid = lower(p_txid)
      AND j.fingerprint_root = lower(p_fingerprint_root)
      AND j.anchor_ids = p_anchor_ids
      AND j.leaf_order = p_leaf_order;

    IF v_matching_count = 1 AND v_exact_count = 1 THEN
      RETURN jsonb_build_object(
        'journal_id', v_existing.id,
        'created', false,
        'outcome', 'EXACT_REPLAY',
        'owner_batch_id', v_existing.batch_id,
        'owner_txid', v_existing.txid,
        'owner_fingerprint_root', v_existing.fingerprint_root,
        'owner_anchor_ids', v_existing.anchor_ids,
        'owner_leaf_order', v_existing.leaf_order,
        'owner_journal_ids', v_matching_journal_ids,
        'protected_anchor_ids', v_protected_anchor_ids,
        'released_anchor_ids', ARRAY[]::uuid[]
      );
    END IF;

    -- This request is not owned by the matching journal. Release every current
    -- anchor that is not protected by an unresolved owner's immutable cohort.
    -- A disjoint batch/tx collision therefore compensates and requeues the
    -- complete losing claim inside THIS transaction instead of stranding it.
    SELECT COALESCE(array_agg(input.anchor_id ORDER BY input.ordinal), ARRAY[]::uuid[])
    INTO v_release_anchor_ids
    FROM unnest(p_anchor_ids) WITH ORDINALITY AS input(anchor_id, ordinal)
    WHERE NOT (input.anchor_id = ANY(v_protected_anchor_ids));

    v_conflict_reason := CASE
      WHEN v_protected_anchor_ids && p_anchor_ids
        THEN 'overlapping_immutable_request_conflict'
      ELSE 'disjoint_batch_or_tx_collision'
    END;

    FOR v_anchor IN
      SELECT a.id, a.org_id, a.metadata
      FROM public.anchors a
      WHERE a.id = ANY(v_release_anchor_ids)
      ORDER BY a.id
    LOOP
      IF v_anchor.metadata->>'queue_credit_source' = 'org_credits'
        AND jsonb_typeof(v_anchor.metadata->'queue_credit_charged_at') = 'string' THEN
        IF v_anchor.org_id IS NULL THEN
          RAISE check_violation
            USING MESSAGE = format('Cannot compensate charged collision anchor %s without org_id', v_anchor.id);
        END IF;
        SELECT public.refund_org_credit(
          v_anchor.org_id,
          1,
          'rule.queue_anchor_run_compensation',
          v_anchor.id
        ) INTO v_refund;
        IF COALESCE((v_refund->>'success')::boolean, false) IS NOT TRUE THEN
          RAISE EXCEPTION 'Collision compensation failed for anchor %: %', v_anchor.id, v_refund
            USING ERRCODE = '23514';
        END IF;
      END IF;
    END LOOP;

    UPDATE public.anchors a
    SET status = 'PENDING',
        updated_at = now(),
        metadata = (
          COALESCE(a.metadata, '{}'::jsonb)
          - '_claimed_by'
          - '_claimed_at'
          - 'queue_credit_source'
          - 'queue_credit_reason'
          - 'queue_credit_charged_at'
          - 'queue_credit_balance_after'
        ) || jsonb_build_object(
          '_recovery_reason', 'txid_journal_identity_conflict',
          '_recovered_at', now()::text
        )
    WHERE a.id = ANY(v_release_anchor_ids)
      AND a.status = 'BROADCASTING'
      AND a.chain_tx_id IS NULL;
    GET DIAGNOSTICS v_released_count = ROW_COUNT;

    IF v_released_count <> cardinality(v_release_anchor_ids) THEN
      RAISE EXCEPTION 'Collision release finalized %/% anchors', v_released_count, cardinality(v_release_anchor_ids)
        USING ERRCODE = '23514';
    END IF;

    RETURN jsonb_build_object(
      'journal_id', v_existing.id,
      'created', false,
      'outcome', 'CONFLICT_UNWOUND',
      'conflict_reason', v_conflict_reason,
      'owner_batch_id', v_existing.batch_id,
      'owner_txid', v_existing.txid,
      'owner_fingerprint_root', v_existing.fingerprint_root,
      'owner_anchor_ids', v_existing.anchor_ids,
      'owner_leaf_order', v_existing.leaf_order,
      'owner_journal_ids', v_matching_journal_ids,
      'protected_anchor_ids', v_protected_anchor_ids,
      'released_anchor_ids', v_release_anchor_ids
    );
  END IF;

  INSERT INTO public.anchor_txid_journal (
    batch_id,
    txid,
    fingerprint_root,
    anchor_ids,
    leaf_order
  ) VALUES (
    p_batch_id,
    lower(p_txid),
    lower(p_fingerprint_root),
    p_anchor_ids,
    p_leaf_order
  )
  RETURNING id INTO v_journal_id;

  RETURN jsonb_build_object(
    'journal_id', v_journal_id,
    'created', true,
    'outcome', 'CREATED',
    'owner_batch_id', p_batch_id,
    'owner_txid', lower(p_txid),
    'owner_fingerprint_root', lower(p_fingerprint_root),
    'owner_anchor_ids', p_anchor_ids,
    'owner_leaf_order', p_leaf_order,
    'owner_journal_ids', ARRAY[v_journal_id],
    'protected_anchor_ids', p_anchor_ids,
    'released_anchor_ids', ARRAY[]::uuid[]
  );
END;
$$;

REVOKE ALL ON FUNCTION public.persist_anchor_txid_journal(text, text, text, uuid[], jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_anchor_txid_journal(text, text, text, uuid[], jsonb) TO service_role;

-- Defense in depth for every status-write path, including service-role code:
-- terminal lifecycle decisions wait until the journal resolves instead of
-- silently making its exact cohort impossible to ADOPT/REVERT/PERSIST.
CREATE OR REPLACE FUNCTION public.guard_anchor_txid_journal_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
    AND NEW.status IN ('REVOKED', 'SUPERSEDED')
    AND EXISTS (
      SELECT 1
      FROM public.anchor_txid_journal j
      WHERE j.recovery_status IN ('PENDING', 'HELD')
        AND NEW.id = ANY(j.anchor_ids)
    ) THEN
    RAISE check_violation
      USING MESSAGE = format(
        'Anchor %s has an unresolved txid journal; resolve it before %s',
        NEW.id,
        NEW.status
      );
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_anchor_txid_journal_lifecycle() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER guard_anchor_txid_journal_lifecycle
  BEFORE UPDATE OF status ON public.anchors
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_anchor_txid_journal_lifecycle();

-- Resolve the journal, credit compensation, proof cleanup, and anchor cohort
-- in one transaction. REVERT validates and locks the COMPLETE cohort before a
-- refund, so any later failure rolls the money and state changes back together.
CREATE OR REPLACE FUNCTION public.resolve_anchor_txid_journal(
  p_journal_id uuid,
  p_action text,
  p_reason text DEFAULT NULL,
  p_block_height bigint DEFAULT NULL,
  p_block_timestamp timestamptz DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '60s'
AS $$
DECLARE
  j public.anchor_txid_journal%ROWTYPE;
  cohort_size integer := 0;
  finalized_size integer := 0;
  locked_size integer := 0;
  v_refund jsonb;
  v_anchor record;
BEGIN
  -- Required by protect_anchor_status_transition/protect_anchor_fields. The
  -- function grant is service-role-only and the setting is transaction-local.
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  IF NOT (p_action IN ('ADOPT', 'REVERT', 'HOLD', 'PERSISTED')) THEN
    RAISE EXCEPTION 'Unsupported txid journal action: %', p_action
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO j
  FROM public.anchor_txid_journal
  WHERE id = p_journal_id;

  IF NOT FOUND THEN
    RAISE no_data_found
      USING MESSAGE = format('Txid journal not found: %s', p_journal_id);
  END IF;

  cohort_size := cardinality(j.anchor_ids);

  IF p_action = 'HOLD' THEN
    SELECT * INTO j
    FROM public.anchor_txid_journal
    WHERE id = p_journal_id
    FOR UPDATE;

    IF j.recovery_status IN ('ADOPTED', 'REVERTED', 'PERSISTED') THEN
      RAISE EXCEPTION 'Txid journal % already resolved as %', p_journal_id, j.recovery_status
        USING ERRCODE = '23514';
    END IF;

    UPDATE public.anchor_txid_journal
    SET recovery_status = 'HELD',
        hold_reason = left(COALESCE(NULLIF(p_reason, ''), 'ambiguous_chain_outcome'), 200),
        held_at = COALESCE(held_at, now()),
        updated_at = now()
    WHERE id = p_journal_id;
    RETURN cohort_size;
  END IF;

  -- Credit paths elsewhere lock org_credits before anchors. REVERT follows the
  -- same order, then every state-changing action locks anchors before journal.
  IF p_action = 'REVERT' THEN
    PERFORM oc.org_id
    FROM public.org_credits oc
    WHERE oc.org_id IN (
      SELECT a.org_id
      FROM public.anchors a
      WHERE a.id = ANY(j.anchor_ids)
        AND a.org_id IS NOT NULL
        AND a.metadata->>'queue_credit_source' = 'org_credits'
        AND jsonb_typeof(a.metadata->'queue_credit_charged_at') = 'string'
    )
    ORDER BY oc.org_id
    FOR UPDATE;
  END IF;

  PERFORM a.id
  FROM public.anchors a
  WHERE a.id = ANY(j.anchor_ids)
  ORDER BY a.id
  FOR UPDATE;
  GET DIAGNOSTICS locked_size = ROW_COUNT;

  IF locked_size <> cohort_size THEN
    RAISE EXCEPTION 'Txid journal % locked %/% anchors', p_journal_id, locked_size, cohort_size
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO j
  FROM public.anchor_txid_journal
  WHERE id = p_journal_id
  FOR UPDATE;

  -- Idempotent same-resolution replay. A contradictory resolution is never
  -- silently rewritten; it requires operator investigation.
  IF j.recovery_status IN ('ADOPTED', 'REVERTED', 'PERSISTED') THEN
    IF (j.recovery_status = 'ADOPTED' AND p_action = 'ADOPT')
      OR (j.recovery_status = 'REVERTED' AND p_action = 'REVERT')
      OR (j.recovery_status = 'PERSISTED' AND p_action = 'PERSISTED')
      OR (j.recovery_status = 'ADOPTED' AND p_action = 'PERSISTED') THEN
      RETURN cohort_size;
    END IF;
    RAISE EXCEPTION 'Txid journal % already resolved as %', p_journal_id, j.recovery_status
      USING ERRCODE = '23514';
  END IF;

  IF p_action = 'ADOPT' THEN
    IF EXISTS (
      SELECT 1
      FROM public.anchors a
      WHERE a.id = ANY(j.anchor_ids)
        AND a.chain_tx_id IS NOT NULL
        AND a.chain_tx_id <> j.txid
    ) THEN
      RAISE EXCEPTION 'Txid journal % cohort contains a conflicting chain_tx_id', p_journal_id
        USING ERRCODE = '23514';
    END IF;

    UPDATE public.anchors a
    SET status = 'SUBMITTED',
        chain_tx_id = j.txid,
        chain_block_height = p_block_height,
        chain_timestamp = p_block_timestamp,
        updated_at = now()
    WHERE a.id = ANY(j.anchor_ids)
      AND a.status IN ('BROADCASTING', 'PENDING')
      AND (a.chain_tx_id IS NULL OR a.chain_tx_id = j.txid);

    SELECT count(*)::integer INTO finalized_size
    FROM public.anchors a
    WHERE a.id = ANY(j.anchor_ids)
      AND a.status IN ('SUBMITTED', 'SECURED')
      AND a.chain_tx_id = j.txid;

    IF finalized_size <> cohort_size THEN
      RAISE EXCEPTION 'ADOPT finalized %/% anchors for journal %', finalized_size, cohort_size, p_journal_id
        USING ERRCODE = '23514';
    END IF;

    UPDATE public.anchor_txid_journal
    SET recovery_status = 'ADOPTED',
        hold_reason = NULL,
        resolved_at = now(),
        updated_at = now()
    WHERE id = p_journal_id;
    RETURN finalized_size;
  END IF;

  IF p_action = 'REVERT' THEN
    IF EXISTS (
      SELECT 1
      FROM public.anchors a
      WHERE a.id = ANY(j.anchor_ids)
        AND (
          a.deleted_at IS NOT NULL
          OR a.status <> 'BROADCASTING'
          OR (a.chain_tx_id IS NOT NULL AND a.chain_tx_id <> j.txid)
        )
    ) THEN
      RAISE EXCEPTION 'Refusing REVERT for journal %: cohort is no longer uniformly eligible', p_journal_id
        USING ERRCODE = '23514';
    END IF;

    -- All cohort rows are locked and eligibility is proven. Compensate inside
    -- this transaction; a failed refund or later state constraint rolls back
    -- every prior refund automatically.
    FOR v_anchor IN
      SELECT a.id, a.org_id, a.metadata
      FROM public.anchors a
      WHERE a.id = ANY(j.anchor_ids)
      ORDER BY a.id
    LOOP
      IF v_anchor.metadata->>'queue_credit_source' = 'org_credits'
        AND jsonb_typeof(v_anchor.metadata->'queue_credit_charged_at') = 'string' THEN
        IF v_anchor.org_id IS NULL THEN
          RAISE check_violation
            USING MESSAGE = format('Cannot compensate charged REVERT anchor %s without org_id', v_anchor.id);
        END IF;
        SELECT public.refund_org_credit(
          v_anchor.org_id,
          1,
          'rule.queue_anchor_run_compensation',
          v_anchor.id
        ) INTO v_refund;
        IF COALESCE((v_refund->>'success')::boolean, false) IS NOT TRUE THEN
          RAISE EXCEPTION 'REVERT compensation failed for anchor %: %', v_anchor.id, v_refund
            USING ERRCODE = '23514';
        END IF;
      END IF;
    END LOOP;

    DELETE FROM public.anchor_proofs ap
    WHERE ap.anchor_id = ANY(j.anchor_ids)
      AND ap.receipt_id = j.txid;

    UPDATE public.anchors a
    SET status = 'PENDING',
        chain_tx_id = NULL,
        chain_block_height = NULL,
        chain_timestamp = NULL,
        updated_at = now(),
        metadata = (
          COALESCE(a.metadata, '{}'::jsonb)
          - '_claimed_by'
          - '_claimed_at'
          - 'queue_credit_source'
          - 'queue_credit_reason'
          - 'queue_credit_charged_at'
          - 'queue_credit_balance_after'
        ) || jsonb_build_object(
          '_recovery_reason', 'txid_journal_affirmative_absence',
          '_recovered_at', now()::text
        )
    WHERE a.id = ANY(j.anchor_ids)
      AND a.status = 'BROADCASTING'
      AND (a.chain_tx_id IS NULL OR a.chain_tx_id = j.txid);

    SELECT count(*)::integer INTO finalized_size
    FROM public.anchors a
    WHERE a.id = ANY(j.anchor_ids)
      AND a.status = 'PENDING'
      AND a.chain_tx_id IS NULL;

    IF finalized_size <> cohort_size THEN
      RAISE EXCEPTION 'REVERT finalized %/% anchors for journal %', finalized_size, cohort_size, p_journal_id
        USING ERRCODE = '23514';
    END IF;

    UPDATE public.anchor_txid_journal
    SET recovery_status = 'REVERTED',
        hold_reason = NULL,
        resolved_at = now(),
        updated_at = now()
    WHERE id = p_journal_id;
    RETURN finalized_size;
  END IF;

  -- PERSISTED is the in-process happy path after submit_batch_anchors. It may
  -- resolve an earlier HELD row if the original worker eventually completed.
  SELECT count(*)::integer INTO finalized_size
  FROM public.anchors a
  WHERE a.id = ANY(j.anchor_ids)
    AND a.status IN ('SUBMITTED', 'SECURED')
    AND a.chain_tx_id = j.txid;

  IF finalized_size <> cohort_size THEN
    RAISE EXCEPTION 'PERSISTED observed %/% finalized anchors for journal %', finalized_size, cohort_size, p_journal_id
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.anchor_txid_journal
  SET recovery_status = 'PERSISTED',
      hold_reason = NULL,
      resolved_at = now(),
      updated_at = now()
  WHERE id = p_journal_id;
  RETURN finalized_size;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_anchor_txid_journal(uuid, text, text, bigint, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_anchor_txid_journal(uuid, text, text, bigint, timestamptz) TO service_role;

-- Replace the generic recovery function atomically. A NULL chain_tx_id is no
-- longer sufficient proof that no tx exists: a worker can crash after the
-- journal insert but before all anchor rows receive their intent marker.
CREATE OR REPLACE FUNCTION public.recover_stuck_broadcasts(
  p_stale_minutes integer DEFAULT 5
) RETURNS TABLE(
  anchor_id uuid,
  anchor_fingerprint text,
  claimed_by text,
  stuck_since timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '60s'
AS $$
BEGIN
  RETURN QUERY
  WITH stuck AS (
    UPDATE public.anchors a
    SET status = 'PENDING',
        updated_at = now(),
        metadata = COALESCE(a.metadata, '{}'::jsonb)
          || jsonb_build_object(
            '_recovery_reason', 'stuck_broadcasting',
            '_recovered_at', now()::text,
            '_previous_claimed_by', COALESCE(a.metadata->>'_claimed_by', 'unknown')
          )
          - '_claimed_by'
          - '_claimed_at'
    WHERE a.id IN (
      SELECT a2.id
      FROM public.anchors a2
      WHERE a2.status = 'BROADCASTING'
        AND a2.updated_at < now() - (p_stale_minutes || ' minutes')::interval
        AND a2.deleted_at IS NULL
        AND a2.chain_tx_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.anchor_txid_journal j
          WHERE j.recovery_status IN ('PENDING', 'HELD')
            AND a2.id = ANY(j.anchor_ids)
        )
      FOR UPDATE SKIP LOCKED
    )
    RETURNING a.id,
      a.fingerprint::text,
      a.metadata->>'_previous_claimed_by' AS claimed_by,
      a.updated_at
  )
  SELECT stuck.id, stuck.fingerprint, stuck.claimed_by, stuck.updated_at
  FROM stuck;
END;
$$;

REVOKE ALL ON FUNCTION public.recover_stuck_broadcasts(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_stuck_broadcasts(integer) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ROLLBACK (run on an isolated mirror, then re-apply this migration):
--   DROP TRIGGER IF EXISTS guard_anchor_txid_journal_lifecycle ON public.anchors;
--   DROP FUNCTION IF EXISTS public.guard_anchor_txid_journal_lifecycle();
--   DROP FUNCTION IF EXISTS public.persist_anchor_txid_journal(text, text, text, uuid[], jsonb);
--   DROP FUNCTION IF EXISTS public.resolve_anchor_txid_journal(uuid, text, text, bigint, timestamptz);
--   Recreate the pre-0358 public.recover_stuck_broadcasts(integer) definition
--   from 00000000000000_baseline_at_main_HEAD.sql, including its
--   chain_tx_id IS NULL predicate and service_role grant.
--   DROP TABLE IF EXISTS public.anchor_txid_journal;
--   NOTIFY pgrst, 'reload schema';
