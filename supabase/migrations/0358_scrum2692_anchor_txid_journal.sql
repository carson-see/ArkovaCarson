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
  signed_at timestamptz NOT NULL,
  recovery_status text NOT NULL DEFAULT 'PENDING',
  hold_reason text,
  held_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT anchor_txid_journal_batch_id_unique UNIQUE (batch_id),
  CONSTRAINT anchor_txid_journal_txid_unique UNIQUE (txid),
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

ALTER TABLE public.anchor_txid_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anchor_txid_journal FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.anchor_txid_journal FROM PUBLIC;
REVOKE ALL ON TABLE public.anchor_txid_journal FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.anchor_txid_journal TO service_role;

COMMENT ON TABLE public.anchor_txid_journal IS
  'SCRUM-2692 service-role-only pre-broadcast txid/cohort journal. PENDING/HELD rows protect their anchors from generic stale recovery.';

-- Resolve the journal and its anchor cohort in one transaction. The worker
-- performs any idempotent credit refund before requesting REVERT; this RPC
-- owns the irreversible anchor/proof/journal state transition.
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
BEGIN
  IF NOT (p_action IN ('ADOPT', 'REVERT', 'HOLD', 'PERSISTED')) THEN
    RAISE EXCEPTION 'Unsupported txid journal action: %', p_action
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO j
  FROM public.anchor_txid_journal
  WHERE id = p_journal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Txid journal not found: %', p_journal_id
      USING ERRCODE = 'P0002';
  END IF;

  cohort_size := cardinality(j.anchor_ids);

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

  IF p_action = 'HOLD' THEN
    UPDATE public.anchor_txid_journal
    SET recovery_status = 'HELD',
        hold_reason = left(COALESCE(NULLIF(p_reason, ''), 'ambiguous_chain_outcome'), 200),
        held_at = COALESCE(held_at, now()),
        updated_at = now()
    WHERE id = p_journal_id;
    RETURN cohort_size;
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
        AND a.status IN ('SUBMITTED', 'SECURED')
        AND a.chain_tx_id = j.txid
    ) THEN
      RAISE EXCEPTION 'Refusing REVERT for journal %: cohort already submitted', p_journal_id
        USING ERRCODE = '23514';
    END IF;

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
--   DROP FUNCTION IF EXISTS public.resolve_anchor_txid_journal(uuid, text, text, bigint, timestamptz);
--   Recreate the pre-0358 public.recover_stuck_broadcasts(integer) definition
--   from 00000000000000_baseline_at_main_HEAD.sql, including its
--   chain_tx_id IS NULL predicate and service_role grant.
--   DROP TABLE IF EXISTS public.anchor_txid_journal;
--   NOTIFY pgrst, 'reload schema';
