-- Migration: 0022_public_verification_revoked.sql
-- Description: Update get_public_anchor to return REVOKED anchors for public verification
-- Rollback: See previous version in 0020_public_verification.sql

-- =============================================================================
-- UPDATE PUBLIC VERIFICATION FUNCTION TO INCLUDE REVOKED STATUS
-- =============================================================================
-- Previously only returned SECURED anchors. Now also returns REVOKED so the
-- public verify page can display a red REVOKED banner.

CREATE OR REPLACE FUNCTION get_public_anchor(p_public_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'public_id', a.public_id,
    'fingerprint', a.fingerprint,
    'status', a.status,
    'filename', a.filename,
    'file_size', a.file_size,
    'secured_at', a.chain_timestamp,
    'network_receipt', a.chain_tx_id,
    'verified', a.status = 'SECURED'
  )
  INTO v_result
  FROM anchors a
  WHERE a.public_id = p_public_id
    AND a.status IN ('SECURED', 'REVOKED')
    AND a.deleted_at IS NULL;

  IF v_result IS NULL THEN
    RETURN jsonb_build_object('error', 'Anchor not found or not verified');
  END IF;

  RETURN v_result;
END;
$$;

-- Grants remain the same
GRANT EXECUTE ON FUNCTION get_public_anchor(text) TO anon;
GRANT EXECUTE ON FUNCTION get_public_anchor(text) TO authenticated;

COMMENT ON FUNCTION get_public_anchor IS 'Returns redacted anchor info for public verification. Returns SECURED and REVOKED anchors.';
