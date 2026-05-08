-- Migration 0248: Finalize duplicate public-record anchor links across chunks
--
-- Public-record anchoring finalizes records in bounded JSON chunks. When many
-- public_records share the same content_hash, they legitimately share one
-- anchor row. Migration 0242 only linked records whose anchor was updated from
-- BROADCASTING inside the current chunk, so duplicate records in later chunks
-- could stay unlinked after the first chunk moved the shared anchor to
-- SUBMITTED. This version treats anchors already finalized by the same tx as
-- eligible for record linking too.
--
-- ROLLBACK:
--   Re-apply the finalize_public_record_anchor_batch definition from
--   migration 0242_pipeline_anchoring_scale.sql.

CREATE OR REPLACE FUNCTION finalize_public_record_anchor_batch(
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
SET statement_timeout = '120s'
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
    FROM jsonb_array_elements(p_items) AS elem
  ),
  anchor_input AS (
    SELECT DISTINCT ON (anchor_id) anchor_id, merkle_proof
    FROM input_data
    ORDER BY anchor_id
  ),
  updated_anchors AS (
    UPDATE anchors a
    SET
      status = 'SUBMITTED',
      chain_tx_id = p_tx_id,
      chain_block_height = p_block_height,
      chain_timestamp = p_block_timestamp,
      updated_at = now(),
      metadata = COALESCE(a.metadata, '{}'::jsonb)
        - '_claimed_by' - '_claimed_at'
        || jsonb_build_object(
          'merkle_proof', ai.merkle_proof,
          'merkle_root', p_merkle_root,
          'batch_id', p_batch_id
        )
    FROM anchor_input ai
    WHERE a.id = ai.anchor_id
      AND a.deleted_at IS NULL
      AND a.status = 'BROADCASTING'
    RETURNING a.id
  ),
  eligible_items AS (
    SELECT i.*
    FROM input_data i
    JOIN anchors a ON a.id = i.anchor_id
    WHERE a.deleted_at IS NULL
      AND a.status IN ('SUBMITTED', 'SECURED')
      AND a.chain_tx_id = p_tx_id
  ),
  updated_records AS (
    UPDATE public_records pr
    SET
      anchor_id = ei.anchor_id,
      updated_at = now(),
      metadata = COALESCE(pr.metadata, '{}'::jsonb)
        || jsonb_build_object(
          'merkle_proof', ei.merkle_proof,
          'merkle_root', p_merkle_root,
          'batch_id', p_batch_id,
          'chain_tx_id', p_tx_id
        )
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

GRANT EXECUTE ON FUNCTION finalize_public_record_anchor_batch(jsonb, text, bigint, timestamptz, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
