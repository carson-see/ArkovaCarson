-- =============================================================================
-- Migration 0041: Expand get_public_anchor RPC to full 5-section spec
-- Story: P6-TS-01
-- Date: 2026-03-10
--
-- PURPOSE
-- -------
-- The existing get_public_anchor() returns minimal fields (fingerprint, status,
-- filename, file_size, secured_at, network_receipt). The full verification spec
-- requires: issuer name, credential type, metadata, chain block height, revocation
-- status/reason, and expiry information.
--
-- This migration also expands the function to return REVOKED anchors with their
-- status (previously only SECURED anchors were returned).
--
-- CHANGES
-- -------
-- 1. Replace get_public_anchor() with expanded return fields
-- =============================================================================

CREATE OR REPLACE FUNCTION get_public_anchor(p_public_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  v_issuer_name text;
  v_anchor RECORD;
BEGIN
  -- Fetch the anchor (SECURED or REVOKED — both have public_id set)
  SELECT a.*
  INTO v_anchor
  FROM anchors a
  WHERE a.public_id = p_public_id
    AND a.status IN ('SECURED', 'REVOKED')
    AND a.deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Anchor not found or not verified');
  END IF;

  -- Look up issuer (organization display_name)
  IF v_anchor.org_id IS NOT NULL THEN
    SELECT o.display_name INTO v_issuer_name
    FROM organizations o
    WHERE o.id = v_anchor.org_id;
  END IF;

  -- Build the full response
  v_result := jsonb_build_object(
    'public_id', v_anchor.public_id,
    'fingerprint', v_anchor.fingerprint,
    'status', v_anchor.status::text,
    'verified', v_anchor.status = 'SECURED',
    'filename', v_anchor.filename,
    'file_size', v_anchor.file_size,
    'credential_type', v_anchor.credential_type::text,
    'issuer_name', v_issuer_name,
    'secured_at', v_anchor.chain_timestamp,
    'network_receipt', v_anchor.chain_tx_id,
    'block_height', v_anchor.chain_block_height,
    'created_at', v_anchor.created_at,
    'issued_at', v_anchor.issued_at,
    'revoked_at', v_anchor.revoked_at,
    'revocation_reason', v_anchor.revocation_reason,
    'expires_at', v_anchor.expires_at,
    'metadata', v_anchor.metadata
  );

  -- Strip null keys to keep response clean
  v_result := (
    SELECT jsonb_object_agg(key, value)
    FROM jsonb_each(v_result)
    WHERE value != 'null'::jsonb
  );

  RETURN v_result;
END;
$$;

-- Keep anonymous access
GRANT EXECUTE ON FUNCTION get_public_anchor(text) TO anon;
GRANT EXECUTE ON FUNCTION get_public_anchor(text) TO authenticated;

COMMENT ON FUNCTION get_public_anchor IS 'Returns full redacted anchor info for public verification (5-section spec)';


-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- Restore from 0020_public_verification.sql (minimal fields, SECURED only)
