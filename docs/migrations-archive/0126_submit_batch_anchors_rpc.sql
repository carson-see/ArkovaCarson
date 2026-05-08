-- Migration 0126: submit_batch_anchors RPC function
--
-- Bulk-updates claimed anchors from BROADCASTING → SUBMITTED (or PENDING → SUBMITTED
-- for legacy path) in a single DB call. Eliminates 100+ individual PostgREST roundtrips
-- that were causing timeouts under load.
--
-- Created directly in production during mainnet migration session (2026-03-26).
-- This migration captures that change for local dev parity.
--
-- ROLLBACK: DROP FUNCTION IF EXISTS submit_batch_anchors;

CREATE OR REPLACE FUNCTION submit_batch_anchors(
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
DECLARE cnt int;
BEGIN
  UPDATE anchors
  SET status = 'SUBMITTED',
    chain_tx_id = p_tx_id,
    chain_block_height = p_block_height,
    chain_timestamp = p_block_timestamp,
    updated_at = now(),
    metadata = COALESCE(metadata, '{}'::jsonb)
      - '_claimed_by' - '_claimed_at'
      || jsonb_build_object('merkle_root', p_merkle_root, 'batch_id', p_batch_id)
  WHERE id = ANY(p_anchor_ids)
    AND status IN ('BROADCASTING', 'PENDING');
  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END;
$$;

-- Grant execute to authenticated (PostgREST needs this for service_role calls)
GRANT EXECUTE ON FUNCTION submit_batch_anchors TO authenticated;
GRANT EXECUTE ON FUNCTION submit_batch_anchors TO service_role;
