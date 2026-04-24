-- Migration 0243: SCALE-02 anchor disk hygiene
--
-- Purpose:
--   1. Reduce avoidable bloat on public.anchors by tuning table storage
--      parameters for a high-update workload.
--   2. Persist batch Merkle proof data in anchor_proofs instead of rewriting
--      anchors.metadata on every batch submit/finalize.
--   3. Override the pipeline batch RPCs so proof data lives in anchor_proofs
--      instead of hot anchors.metadata rows.
--
-- Notes:
--   - This migration is intentionally additive and low-risk. It stops NEW
--     anchors from bloating as quickly. Existing bloat still requires online
--     maintenance (pg_repack) or a lock-taking rewrite to reclaim space.
--   - We do NOT mass-update existing anchors.metadata here because that would
--     create another large wave of dead tuples on the hottest table.
--
-- Rollback:
--   - Restore prior submit_batch_anchors / finalize_public_record_anchor_batch /
--     link_public_records_to_anchors bodies if you intentionally want proof
--     data back in anchors.metadata.
--   - Reset anchors reloptions manually if necessary.

-- ---------------------------------------------------------------------------
-- 1. Make anchor_proofs usable for batch Merkle proof persistence
-- ---------------------------------------------------------------------------
ALTER TABLE public.anchor_proofs
  ADD COLUMN IF NOT EXISTS batch_id text;

ALTER TABLE public.anchor_proofs
  ALTER COLUMN block_height DROP NOT NULL;

ALTER TABLE public.anchor_proofs
  ALTER COLUMN block_timestamp DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_anchor_proofs_batch_id
  ON public.anchor_proofs (batch_id)
  WHERE batch_id IS NOT NULL;

COMMENT ON COLUMN public.anchor_proofs.batch_id IS
  'Internal Merkle batch identifier for batch-anchored records.';

-- ---------------------------------------------------------------------------
-- 2. Tune anchors for a high-churn workload
-- ---------------------------------------------------------------------------
ALTER TABLE public.anchors SET (
  fillfactor = 70,
  autovacuum_vacuum_scale_factor = 0.005,
  autovacuum_vacuum_threshold = 5000,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_analyze_threshold = 5000,
  toast.autovacuum_vacuum_scale_factor = 0.01,
  toast.autovacuum_vacuum_threshold = 5000
);

COMMENT ON TABLE public.anchors IS
  'Primary anchor records. SCALE-02: fillfactor/autovacuum tuned for high-write batch anchoring workload.';

-- ---------------------------------------------------------------------------
-- 3. Stop submit_batch_anchors from rewriting anchors.metadata
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_batch_anchors(
  p_anchor_ids uuid[],
  p_tx_id text,
  p_block_height bigint DEFAULT NULL,
  p_block_timestamp timestamptz DEFAULT NULL,
  p_merkle_root text DEFAULT NULL,
  p_batch_id text DEFAULT NULL
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout TO '60s'
AS $$
DECLARE
  cnt int;
BEGIN
  UPDATE public.anchors
  SET
    status = 'SUBMITTED',
    chain_tx_id = p_tx_id,
    chain_block_height = p_block_height,
    chain_timestamp = p_block_timestamp,
    updated_at = now()
  WHERE id = ANY(p_anchor_ids)
    AND status IN ('BROADCASTING', 'PENDING');

  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_batch_anchors(uuid[], text, bigint, timestamptz, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_batch_anchors(uuid[], text, bigint, timestamptz, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_batch_anchors(uuid[], text, bigint, timestamptz, text, text) TO service_role;

COMMENT ON FUNCTION public.submit_batch_anchors(uuid[], text, bigint, timestamptz, text, text) IS
  'Bulk-updates anchors to SUBMITTED without rewriting anchors.metadata. SCALE-02 stores batch proof data in anchor_proofs instead.';

-- ---------------------------------------------------------------------------
-- 4. Override pipeline batch RPCs to use anchor_proofs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_public_record_anchor_batch(
  p_items jsonb,
  p_tx_id text,
  p_block_height bigint DEFAULT NULL,
  p_block_timestamp timestamptz DEFAULT NULL,
  p_merkle_root text DEFAULT NULL,
  p_batch_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout TO '60s'
AS $$
DECLARE
  v_anchors_updated bigint := 0;
  v_records_updated bigint := 0;
BEGIN
  WITH input_data AS (
    SELECT
      (elem->>'record_id')::uuid AS record_id,
      (elem->>'anchor_id')::uuid AS anchor_id,
      COALESCE(elem->'merkle_proof', '[]'::jsonb) AS merkle_proof
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) AS elem
  ),
  anchor_input AS (
    SELECT DISTINCT ON (anchor_id) anchor_id
    FROM input_data
    ORDER BY anchor_id
  ),
  updated_anchors AS (
    UPDATE public.anchors a
    SET
      status = 'SUBMITTED',
      chain_tx_id = p_tx_id,
      chain_block_height = p_block_height,
      chain_timestamp = p_block_timestamp,
      updated_at = now()
    FROM anchor_input ai
    WHERE a.id = ai.anchor_id
      AND a.deleted_at IS NULL
      AND a.status = 'BROADCASTING'
    RETURNING a.id
  ),
  eligible_items AS (
    SELECT i.record_id, i.anchor_id, i.merkle_proof
    FROM input_data i
    JOIN updated_anchors ua ON ua.id = i.anchor_id
  ),
  upserted_proofs AS (
    INSERT INTO public.anchor_proofs (
      anchor_id,
      receipt_id,
      block_height,
      block_timestamp,
      merkle_root,
      proof_path,
      batch_id
    )
    SELECT
      ei.anchor_id,
      p_tx_id,
      p_block_height::int,
      p_block_timestamp,
      p_merkle_root,
      ei.merkle_proof,
      p_batch_id
    FROM eligible_items ei
    ON CONFLICT (anchor_id) DO UPDATE
    SET
      receipt_id = EXCLUDED.receipt_id,
      block_height = EXCLUDED.block_height,
      block_timestamp = EXCLUDED.block_timestamp,
      merkle_root = EXCLUDED.merkle_root,
      proof_path = EXCLUDED.proof_path,
      batch_id = EXCLUDED.batch_id
    RETURNING anchor_id
  ),
  updated_records AS (
    UPDATE public.public_records pr
    SET
      anchor_id = ei.anchor_id,
      updated_at = now(),
      metadata = COALESCE(pr.metadata, '{}'::jsonb)
        || jsonb_strip_nulls(jsonb_build_object(
          'merkle_proof', ei.merkle_proof,
          'merkle_root', p_merkle_root,
          'batch_id', p_batch_id,
          'chain_tx_id', p_tx_id
        ))
    FROM eligible_items ei
    WHERE pr.id = ei.record_id
      AND (pr.anchor_id IS NULL OR pr.anchor_id = ei.anchor_id)
    RETURNING pr.id
  )
  SELECT
    (SELECT count(*) FROM updated_anchors),
    (SELECT count(*) FROM updated_records)
  INTO v_anchors_updated, v_records_updated;

  RETURN jsonb_build_object(
    'anchors_updated', COALESCE(v_anchors_updated, 0),
    'records_updated', COALESCE(v_records_updated, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_public_record_anchor_batch(jsonb, text, bigint, timestamptz, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_public_record_anchor_batch(jsonb, text, bigint, timestamptz, text, text) TO service_role;

COMMENT ON FUNCTION public.finalize_public_record_anchor_batch(jsonb, text, bigint, timestamptz, text, text) IS
  'Finalizes public-record Merkle batches without rewriting anchors.metadata; proof data lives in anchor_proofs.';

CREATE OR REPLACE FUNCTION public.link_public_records_to_anchors(
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout TO '60s'
AS $$
DECLARE
  v_records_updated bigint := 0;
BEGIN
  WITH input_data AS (
    SELECT
      (elem->>'record_id')::uuid AS record_id,
      (elem->>'anchor_id')::uuid AS anchor_id
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) AS elem
  ),
  updated_records AS (
    UPDATE public.public_records pr
    SET
      anchor_id = i.anchor_id,
      updated_at = now(),
      metadata = COALESCE(pr.metadata, '{}'::jsonb)
        || jsonb_strip_nulls(jsonb_build_object(
          'merkle_proof', COALESCE(ap.proof_path, a.metadata->'merkle_proof', '[]'::jsonb),
          'merkle_root', COALESCE(ap.merkle_root, a.metadata->>'merkle_root'),
          'batch_id', COALESCE(ap.batch_id, a.metadata->>'batch_id'),
          'chain_tx_id', a.chain_tx_id
        ))
    FROM input_data i
    JOIN public.anchors a ON a.id = i.anchor_id
    LEFT JOIN public.anchor_proofs ap ON ap.anchor_id = a.id
    WHERE pr.id = i.record_id
      AND (pr.anchor_id IS NULL OR pr.anchor_id = i.anchor_id)
      AND a.deleted_at IS NULL
      AND a.status IN ('SUBMITTED', 'SECURED')
      AND a.chain_tx_id IS NOT NULL
    RETURNING pr.id
  )
  SELECT count(*) INTO v_records_updated FROM updated_records;

  RETURN jsonb_build_object('records_updated', COALESCE(v_records_updated, 0));
END;
$$;

REVOKE ALL ON FUNCTION public.link_public_records_to_anchors(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.link_public_records_to_anchors(jsonb) TO service_role;

COMMENT ON FUNCTION public.link_public_records_to_anchors(jsonb) IS
  'Links public_records to already-bitcoin-anchored anchors, preferring anchor_proofs over legacy metadata.';
