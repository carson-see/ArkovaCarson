-- 0407: SUPPLEMENTARY PROOF ANCHOR (SCRUM-3188)
--
-- WHY
--   2,969,630 SECURED anchors hold a REAL first attestation on Bitcoin but no
--   per-document Merkle branch. The Mar/Apr producer never persisted the
--   committed leaf ORDER, and for batches >8 leaves that order is unrecoverable
--   (PR #2130 / migration 0406 recovers the 608 records where it IS searchable
--   and classifies the rest `unreconstructible_order`).
--
--   The only sound remedy for the remainder is a SECOND Bitcoin transaction
--   re-committing the same fingerprints in a RECORDED order. This migration adds
--   the schema for that, and nothing else: no backfill, no data rewrite, no
--   proof is created here.
--
-- THE INTEGRITY CONSTRAINT THIS SCHEMA ENFORCES
--   The original attestation (anchors.chain_tx_id / chain_timestamp /
--   chain_block_height / chain_block_hash) is READ-ONLY to this subsystem.
--   Overwriting it would backdate-shift a genuine 2026-06 commitment to today
--   and destroy the evidence the product sells. Nothing below writes to
--   `anchors` at all — `insert_supplementary_proofs` only INSERTs into
--   `anchor_proofs`, and it re-checks against `anchors.chain_tx_id` rather than
--   trusting the caller. Formalised as the TLA invariant
--   `supplementaryRequiresOriginalAttestation` in machines/bitcoinAnchor.machine.ts.
--
-- WHY A SEPARATE JOURNAL TABLE (load-bearing, not tidiness)
--   `anchor_txid_journal` (0358) is swept by reconcileTxidJournals(), whose
--   ADOPT branch WRITES anchors.chain_tx_id. Pointing supplementary runs at that
--   table would let the primary recovery sweep overwrite the original
--   attestation of 2.97M SECURED anchors — the precise catastrophe this work
--   exists to prevent. `supplementary_anchor_journal` is therefore physically
--   separate and is never read by that sweep.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.supplementary_proof_backlog_count(integer);
--   DROP FUNCTION IF EXISTS public.insert_supplementary_proofs(jsonb);
--   DROP FUNCTION IF EXISTS public.claim_supplementary_proof_cohort(integer, uuid[], text[]);
--   DROP FUNCTION IF EXISTS public.resolve_supplementary_journal(uuid, text, text);
--   DROP FUNCTION IF EXISTS public.persist_supplementary_journal(text, text, text, uuid[], jsonb, uuid);
--   DROP TABLE IF EXISTS public.supplementary_anchor_journal;
--   DROP TABLE IF EXISTS public.supplementary_anchor_runs;
--   ALTER TABLE public.anchor_proofs DROP CONSTRAINT IF EXISTS anchor_proofs_supplementary_shape;
--   ALTER TABLE public.anchor_proofs DROP COLUMN IF EXISTS supplements_chain_tx_id;
--   ALTER TABLE public.anchor_proofs DROP COLUMN IF EXISTS is_supplementary;

-- ---------------------------------------------------------------------------
-- 1. Discriminator columns on anchor_proofs
-- ---------------------------------------------------------------------------
--
-- `anchor_proofs.anchor_id` is UNIQUE, so a supplementary row IS the anchor's
-- only proof row. Without an explicit discriminator the verify API would read
-- the supplementary transaction as the record's FIRST attestation — silently
-- overclaiming a 2026-08 date for a 2026-06 commitment. These two columns make
-- the distinction structural and impossible to lose.
--
-- Both are metadata-only ALTERs (PG11+ fast default), so no table rewrite and
-- no long lock on a 505k-row table.
ALTER TABLE public.anchor_proofs
  ADD COLUMN IF NOT EXISTS is_supplementary boolean NOT NULL DEFAULT false;

ALTER TABLE public.anchor_proofs
  ADD COLUMN IF NOT EXISTS supplements_chain_tx_id text;

COMMENT ON COLUMN public.anchor_proofs.is_supplementary IS
  'SCRUM-3188: TRUE when receipt_id is a LATER, supplementary transaction rather '
  'than the anchor''s original attestation. The verify API MUST surface both facts '
  'separately and must never present a supplementary tx as the first commitment.';

COMMENT ON COLUMN public.anchor_proofs.supplements_chain_tx_id IS
  'SCRUM-3188: the ORIGINAL anchors.chain_tx_id this supplementary proof supplements. '
  'Mandatory when is_supplementary, NULL otherwise. Never written over; the original '
  'attestation columns on anchors are read-only to this subsystem.';

-- NOT VALID first so the ADD takes only a brief ACCESS EXCLUSIVE lock; VALIDATE
-- then scans under SHARE UPDATE EXCLUSIVE, which does not block reads/writes.
ALTER TABLE public.anchor_proofs
  ADD CONSTRAINT anchor_proofs_supplementary_shape CHECK (
    (is_supplementary = false AND supplements_chain_tx_id IS NULL)
    OR (is_supplementary = true AND supplements_chain_tx_id ~ '^[0-9a-f]{64}$')
  ) NOT VALID;

ALTER TABLE public.anchor_proofs
  VALIDATE CONSTRAINT anchor_proofs_supplementary_shape;

CREATE INDEX IF NOT EXISTS idx_anchor_proofs_supplementary
  ON public.anchor_proofs (is_supplementary)
  WHERE is_supplementary = true;

-- Extend the 0354/0406 class vocabulary with this subsystem's outcome.
COMMENT ON COLUMN public.anchor_proofs.proof_completeness_class IS
  'Honest per-record proof state. 0354: already_complete | batch_provable | direct_anchored | ambiguous. '
  '0406 (SCRUM-3187): recovered_branch | recovered_single_leaf | unreconstructible_order | '
  'unreconstructible_no_root | rejected_stored_branch. '
  '0407 (SCRUM-3188): supplementary_anchored - the ORIGINAL attestation stands and is authoritative for '
  'FIRST-COMMITTED time, and a per-document branch is available from a LATER supplementary transaction '
  '(see is_supplementary / supplements_chain_tx_id). Both facts must be stated; neither may be presented as the other. '
  'unreconstructible_* remains a TERMINAL, truthful state until a supplementary anchor supersedes it.';

-- ---------------------------------------------------------------------------
-- 2. Durable run progress (resumability)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.supplementary_anchor_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'RUNNING',
  dry_run boolean NOT NULL DEFAULT true,
  batch_size integer NOT NULL,
  fee_rate_sat_vb integer,
  batches_completed integer NOT NULL DEFAULT 0,
  anchors_proven integer NOT NULL DEFAULT 0,
  sats_spent bigint NOT NULL DEFAULT 0,
  last_error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT supplementary_runs_status CHECK (
    status IN ('RUNNING', 'PAUSED', 'COMPLETED', 'ABORTED')
  ),
  CONSTRAINT supplementary_runs_batch_size CHECK (batch_size BETWEEN 1 AND 10000),
  CONSTRAINT supplementary_runs_fee_rate CHECK (fee_rate_sat_vb IS NULL OR fee_rate_sat_vb BETWEEN 1 AND 1000),
  CONSTRAINT supplementary_runs_counters CHECK (
    batches_completed >= 0 AND anchors_proven >= 0 AND sats_spent >= 0
  ),
  CONSTRAINT supplementary_runs_last_error_bounded CHECK (
    last_error IS NULL OR char_length(last_error) BETWEEN 1 AND 500
  )
);

ALTER TABLE public.supplementary_anchor_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplementary_anchor_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY supplementary_anchor_runs_deny_clients
  ON public.supplementary_anchor_runs FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

REVOKE ALL ON TABLE public.supplementary_anchor_runs FROM PUBLIC;
REVOKE ALL ON TABLE public.supplementary_anchor_runs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.supplementary_anchor_runs TO service_role;

COMMENT ON TABLE public.supplementary_anchor_runs IS
  'SCRUM-3188 service-role-only durable progress for supplementary re-anchor runs. '
  'Lets an interrupted run resume without re-broadcasting completed batches.';

-- ---------------------------------------------------------------------------
-- 3. Supplementary txid journal — the anti-double-broadcast barrier
-- ---------------------------------------------------------------------------
--
-- Same contract as anchor_txid_journal (0358) but PHYSICALLY SEPARATE so the
-- primary reconcileTxidJournals() sweep — which writes anchors.chain_tx_id on
-- ADOPT — can never touch a supplementary cohort. See the header note.
--
-- The two partial unique indexes are the actual double-spend protection: a
-- txid, and a batch, can each be live exactly once. A crash between sign and
-- broadcast leaves a PENDING row; the resume path finds it and either ADOPTs
-- the exact txid it already signed or REVERTs on affirmative absence. It never
-- signs a second, different transaction for the same cohort.
CREATE TABLE IF NOT EXISTS public.supplementary_anchor_journal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES public.supplementary_anchor_runs(id) ON DELETE SET NULL,
  batch_id text NOT NULL,
  txid text NOT NULL,
  fingerprint_root text NOT NULL,
  anchor_ids uuid[] NOT NULL,
  leaf_order jsonb NOT NULL,
  -- Database-authored: recovery age must never trust a worker clock.
  signed_at timestamptz NOT NULL DEFAULT now(),
  recovery_status text NOT NULL DEFAULT 'PENDING',
  hold_reason text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supp_journal_batch_id_bounded CHECK (char_length(batch_id) BETWEEN 1 AND 200),
  CONSTRAINT supp_journal_txid_hex CHECK (txid ~ '^[0-9a-f]{64}$'),
  CONSTRAINT supp_journal_root_hex CHECK (fingerprint_root ~ '^[0-9a-f]{64}$'),
  CONSTRAINT supp_journal_cohort_bounded CHECK (cardinality(anchor_ids) BETWEEN 1 AND 10000),
  CONSTRAINT supp_journal_leaf_order_array CHECK (
    jsonb_typeof(leaf_order) = 'array'
    AND jsonb_array_length(leaf_order) = cardinality(anchor_ids)
  ),
  CONSTRAINT supp_journal_recovery_status CHECK (
    recovery_status IN ('PENDING', 'HELD', 'ADOPTED', 'REVERTED', 'PERSISTED')
  ),
  CONSTRAINT supp_journal_resolution_shape CHECK (
    (recovery_status IN ('PENDING', 'HELD') AND resolved_at IS NULL)
    OR (recovery_status IN ('ADOPTED', 'REVERTED', 'PERSISTED') AND resolved_at IS NOT NULL)
  ),
  CONSTRAINT supp_journal_hold_reason_bounded CHECK (
    hold_reason IS NULL OR char_length(hold_reason) BETWEEN 1 AND 200
  )
);

-- A REVERTED attempt is audit history, not a permanent retry ban: a
-- deterministic signer may legitimately reproduce the same txid afterwards.
CREATE UNIQUE INDEX IF NOT EXISTS supp_journal_live_txid_unique
  ON public.supplementary_anchor_journal (txid)
  WHERE recovery_status <> 'REVERTED';

CREATE UNIQUE INDEX IF NOT EXISTS supp_journal_live_batch_unique
  ON public.supplementary_anchor_journal (batch_id)
  WHERE recovery_status <> 'REVERTED';

CREATE INDEX IF NOT EXISTS supp_journal_unresolved_idx
  ON public.supplementary_anchor_journal (recovery_status, updated_at, id)
  WHERE recovery_status IN ('PENDING', 'HELD');

ALTER TABLE public.supplementary_anchor_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplementary_anchor_journal FORCE ROW LEVEL SECURITY;

CREATE POLICY supplementary_anchor_journal_deny_clients
  ON public.supplementary_anchor_journal FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

REVOKE ALL ON TABLE public.supplementary_anchor_journal FROM PUBLIC;
REVOKE ALL ON TABLE public.supplementary_anchor_journal FROM anon, authenticated;
GRANT SELECT ON TABLE public.supplementary_anchor_journal TO service_role;

COMMENT ON TABLE public.supplementary_anchor_journal IS
  'SCRUM-3188 service-role-only pre-broadcast txid journal for SUPPLEMENTARY anchors. '
  'Deliberately separate from anchor_txid_journal: that table''s recovery sweep writes '
  'anchors.chain_tx_id, which must never happen to an already-SECURED anchor.';

-- ---------------------------------------------------------------------------
-- 4. Persist the supplementary journal (pre-broadcast barrier)
-- ---------------------------------------------------------------------------
--
-- Returns the OWNING journal row. An exact replay of the same (batch, txid,
-- root, cohort) is idempotent and reports EXACT_REPLAY so a resumed run defers
-- instead of broadcasting again. A different txid for a live batch, or a
-- reused txid, is a CONFLICT the caller must not broadcast through.
CREATE OR REPLACE FUNCTION public.persist_supplementary_journal(
  p_batch_id text,
  p_txid text,
  p_fingerprint_root text,
  p_anchor_ids uuid[],
  p_leaf_order jsonb,
  p_run_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.supplementary_anchor_journal%ROWTYPE;
  v_id uuid;
  v_secured_count integer;
BEGIN
  IF p_anchor_ids IS NULL OR cardinality(p_anchor_ids) NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'supplementary journal: cohort must hold 1..10000 anchors';
  END IF;

  IF jsonb_typeof(p_leaf_order) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_leaf_order) <> cardinality(p_anchor_ids) THEN
    RAISE EXCEPTION 'supplementary journal: leaf_order must align with anchor_ids';
  END IF;

  -- The recorded order must agree with the cohort, positionally. This is the
  -- defect that created the backlog; refuse to persist a journal that could not
  -- reproduce its own root.
  IF EXISTS (
    SELECT 1
    FROM unnest(p_anchor_ids) WITH ORDINALITY AS input(anchor_id, ordinal)
    WHERE (p_leaf_order -> ((input.ordinal - 1)::integer) ->> 'anchor_id')
            IS DISTINCT FROM input.anchor_id::text
  ) THEN
    RAISE EXCEPTION 'supplementary journal: leaf_order does not match anchor_ids positionally';
  END IF;

  -- A supplementary anchor supplements a COMPLETED attestation. Every member
  -- must be SECURED with a chain_tx_id, or this is not a supplementary run.
  SELECT count(*) INTO v_secured_count
  FROM public.anchors a
  WHERE a.id = ANY(p_anchor_ids)
    AND a.status = 'SECURED'
    AND a.chain_tx_id IS NOT NULL
    AND a.deleted_at IS NULL;

  IF v_secured_count <> cardinality(p_anchor_ids) THEN
    RAISE EXCEPTION 'supplementary journal: cohort contains % non-SECURED anchors',
      cardinality(p_anchor_ids) - v_secured_count;
  END IF;

  SELECT * INTO v_existing
  FROM public.supplementary_anchor_journal
  WHERE txid = lower(p_txid) AND recovery_status <> 'REVERTED'
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.batch_id = p_batch_id
       AND v_existing.fingerprint_root = lower(p_fingerprint_root)
       AND v_existing.anchor_ids = p_anchor_ids THEN
      RETURN jsonb_build_object(
        'journal_id', v_existing.id, 'outcome', 'EXACT_REPLAY', 'created', false
      );
    END IF;
    RETURN jsonb_build_object(
      'journal_id', v_existing.id, 'outcome', 'CONFLICT', 'created', false,
      'conflict_reason', 'txid already live under a different cohort'
    );
  END IF;

  SELECT * INTO v_existing
  FROM public.supplementary_anchor_journal
  WHERE batch_id = p_batch_id AND recovery_status <> 'REVERTED'
  FOR UPDATE;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'journal_id', v_existing.id, 'outcome', 'CONFLICT', 'created', false,
      'conflict_reason', 'batch already live under a different txid'
    );
  END IF;

  INSERT INTO public.supplementary_anchor_journal
    (run_id, batch_id, txid, fingerprint_root, anchor_ids, leaf_order)
  VALUES
    (p_run_id, p_batch_id, lower(p_txid), lower(p_fingerprint_root), p_anchor_ids, p_leaf_order)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('journal_id', v_id, 'outcome', 'CREATED', 'created', true);
END;
$$;

REVOKE ALL ON FUNCTION public.persist_supplementary_journal(text, text, text, uuid[], jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.persist_supplementary_journal(text, text, text, uuid[], jsonb, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Resolve a supplementary journal
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_supplementary_journal(
  p_journal_id uuid,
  p_action text,
  p_reason text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  IF p_action NOT IN ('ADOPT', 'REVERT', 'HOLD', 'PERSIST') THEN
    RAISE EXCEPTION 'supplementary journal: unknown action %', p_action;
  END IF;

  v_status := CASE p_action
    WHEN 'ADOPT' THEN 'ADOPTED'
    WHEN 'REVERT' THEN 'REVERTED'
    WHEN 'HOLD' THEN 'HELD'
    ELSE 'PERSISTED'
  END;

  UPDATE public.supplementary_anchor_journal
  SET recovery_status = v_status,
      hold_reason = left(p_reason, 200),
      resolved_at = CASE WHEN v_status = 'HELD' THEN NULL ELSE now() END,
      updated_at = now()
  WHERE id = p_journal_id
    AND recovery_status IN ('PENDING', 'HELD');

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_supplementary_journal(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_supplementary_journal(uuid, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. Claim a cohort needing a supplementary proof
-- ---------------------------------------------------------------------------
--
-- Bounded and index-friendly: never a full scan of the 3.5M-row anchors table
-- in one statement, and it takes NO row locks (this is a read; the journal's
-- unique indexes provide the mutual exclusion). Prioritisation is
-- operator-parameterised rather than hardcoded — real customer orgs first,
-- bulk public-records ingestion (PUBLICATION / SEC_FILING) last.
CREATE OR REPLACE FUNCTION public.claim_supplementary_proof_cohort(
  p_limit integer DEFAULT 10000,
  p_priority_org_ids uuid[] DEFAULT NULL,
  p_deprioritized_credential_types text[] DEFAULT NULL
)
RETURNS TABLE (anchor_id uuid, fingerprint text, chain_tx_id text, org_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id, a.fingerprint, a.chain_tx_id, a.org_id
  FROM public.anchors a
  WHERE a.status = 'SECURED'
    AND a.deleted_at IS NULL
    AND a.chain_tx_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.anchor_proofs p WHERE p.anchor_id = a.id)
    -- Never re-enter a cohort that already has a live journal.
    AND NOT EXISTS (
      SELECT 1 FROM public.supplementary_anchor_journal j
      WHERE j.recovery_status IN ('PENDING', 'HELD', 'ADOPTED', 'PERSISTED')
        AND a.id = ANY(j.anchor_ids)
    )
  ORDER BY
    (p_priority_org_ids IS NOT NULL AND a.org_id = ANY(p_priority_org_ids)) DESC,
    (p_deprioritized_credential_types IS NOT NULL
      AND a.credential_type = ANY(p_deprioritized_credential_types)) ASC,
    a.created_at ASC
  LIMIT least(greatest(coalesce(p_limit, 10000), 1), 10000);
$$;

REVOKE ALL ON FUNCTION public.claim_supplementary_proof_cohort(integer, uuid[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_supplementary_proof_cohort(integer, uuid[], text[]) TO service_role;

-- ---------------------------------------------------------------------------
-- 7. Insert verified supplementary proofs
-- ---------------------------------------------------------------------------
--
-- Defense in depth. Even if the worker were wrong, this function:
--   * writes ONLY to anchor_proofs — it never touches `anchors`, so the
--     original attestation cannot be altered by this path at all;
--   * re-derives supplements_chain_tx_id from anchors.chain_tx_id rather than
--     trusting the caller's value, so a supplementary row can never claim to
--     supplement a transaction that is not the anchor's actual attestation;
--   * refuses any anchor that is not SECURED with a chain_tx_id;
--   * refuses a supplementary txid equal to the original attestation;
--   * uses ON CONFLICT (anchor_id) DO NOTHING, so a genuine pre-existing proof
--     is NEVER clobbered by a supplementary write.
CREATE OR REPLACE FUNCTION public.insert_supplementary_proofs(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted integer;
BEGIN
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'insert_supplementary_proofs: p_rows must be a JSON array';
  END IF;

  IF jsonb_array_length(p_rows) > 10000 THEN
    RAISE EXCEPTION 'insert_supplementary_proofs: at most 10000 rows per call';
  END IF;

  WITH input AS (
    SELECT
      (r ->> 'anchor_id')::uuid   AS anchor_id,
      lower(r ->> 'receipt_id')   AS receipt_id,
      lower(r ->> 'merkle_root')  AS merkle_root,
      r -> 'proof_path'           AS proof_path,
      (r ->> 'merkle_index')::int AS merkle_index,
      r ->> 'batch_id'            AS batch_id,
      NULLIF(r ->> 'block_height', '')::int            AS block_height,
      NULLIF(r ->> 'block_timestamp', '')::timestamptz AS block_timestamp
    FROM jsonb_array_elements(p_rows) AS r
  ),
  validated AS (
    SELECT i.*, a.chain_tx_id AS original_tx_id
    FROM input i
    JOIN public.anchors a ON a.id = i.anchor_id
    WHERE a.status = 'SECURED'
      AND a.deleted_at IS NULL
      AND a.chain_tx_id IS NOT NULL
      -- A supplementary anchor is by definition a SECOND transaction.
      AND lower(a.chain_tx_id) <> i.receipt_id
      AND i.receipt_id ~ '^[0-9a-f]{64}$'
      AND i.merkle_root ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof(i.proof_path) = 'array'
      AND i.merkle_index >= 0
  ),
  ins AS (
    INSERT INTO public.anchor_proofs (
      anchor_id, receipt_id, merkle_root, proof_path, merkle_index, batch_id,
      block_height, block_timestamp, is_supplementary, supplements_chain_tx_id,
      proof_completeness_class
    )
    SELECT
      v.anchor_id, v.receipt_id, v.merkle_root, v.proof_path, v.merkle_index, v.batch_id,
      v.block_height, v.block_timestamp, true, lower(v.original_tx_id),
      'supplementary_anchored'
    FROM validated v
    ON CONFLICT (anchor_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_inserted FROM ins;

  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.insert_supplementary_proofs(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.insert_supplementary_proofs(jsonb) TO service_role;

COMMENT ON FUNCTION public.insert_supplementary_proofs(jsonb) IS
  'SCRUM-3188: insert chain-VERIFIED supplementary proof rows. Writes only to anchor_proofs; '
  're-derives the supplemented txid from anchors.chain_tx_id rather than trusting the caller; '
  'never overwrites an existing proof row.';

-- ---------------------------------------------------------------------------
-- 8. Bounded backlog count (for the dry-run estimate)
-- ---------------------------------------------------------------------------
--
-- R0-8 / SCRUM-1254: never an unbounded count(*) on the 3.5M-row anchors table.
-- Counting stops at p_max and reports whether it was capped, so the dry run can
-- honestly say "at least N" instead of blocking on a full scan.
CREATE OR REPLACE FUNCTION public.supplementary_proof_backlog_count(
  p_max integer DEFAULT 1000000
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH bounded AS (
    SELECT 1 AS hit
    FROM public.anchors a
    WHERE a.status = 'SECURED'
      AND a.deleted_at IS NULL
      AND a.chain_tx_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.anchor_proofs p WHERE p.anchor_id = a.id)
    LIMIT least(greatest(coalesce(p_max, 1000000), 1), 5000000)
  )
  SELECT jsonb_build_object(
    'count', (SELECT count(*) FROM bounded),
    'capped', (SELECT count(*) FROM bounded)
                >= least(greatest(coalesce(p_max, 1000000), 1), 5000000)
  );
$$;

REVOKE ALL ON FUNCTION public.supplementary_proof_backlog_count(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.supplementary_proof_backlog_count(integer) TO service_role;
