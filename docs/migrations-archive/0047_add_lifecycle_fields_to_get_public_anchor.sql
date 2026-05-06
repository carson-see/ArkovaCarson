-- =============================================================================
-- Migration 0047: Add lifecycle fields to get_public_anchor response
-- Date: 2026-03-11
--
-- PURPOSE
-- -------
-- The PublicVerification page (P6-TS-04) needs lifecycle timeline data:
-- created_at, revoked_at, revocation_reason, and expires_at (already present).
-- Also maps issued_date → issued_at and anchor_timestamp → secured_at for
-- the AnchorLifecycleTimeline component.
--
-- These fields are added to the "Additional fields for UI" section of the
-- response. They are NOT part of the Phase 1.5 frozen API schema.
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
  v_recipient_raw text;
  v_recipient_hash text;
  v_jurisdiction text;
  v_status_mapped text;
BEGIN
  -- Look up anchor — only non-deleted, non-PENDING anchors are returned
  SELECT
    -- Map internal status to public status
    CASE a.status
      WHEN 'SECURED' THEN 'ACTIVE'
      WHEN 'REVOKED' THEN 'REVOKED'
      WHEN 'EXPIRED' THEN 'EXPIRED'
      ELSE a.status::text
    END,
    -- Extract issuer from metadata (fallback to org display_name, then 'Unknown')
    COALESCE(
      a.metadata->>'issuer',
      o.display_name,
      'Unknown Issuer'
    ),
    -- Extract raw recipient from metadata for hashing
    a.metadata->>'recipient',
    -- Extract jurisdiction from metadata (may be null)
    a.metadata->>'jurisdiction'
  INTO
    v_status_mapped,
    v_issuer_name,
    v_recipient_raw,
    v_jurisdiction
  FROM anchors a
  LEFT JOIN organizations o ON o.id = a.org_id
  WHERE a.public_id = p_public_id
    AND a.status IN ('SECURED', 'REVOKED', 'EXPIRED')
    AND a.deleted_at IS NULL;

  -- Not found
  IF v_status_mapped IS NULL THEN
    RETURN jsonb_build_object('error', 'Record not found or not yet verified');
  END IF;

  -- Hash the recipient identifier (SHA-256) — never expose raw PII
  IF v_recipient_raw IS NOT NULL AND v_recipient_raw != '' THEN
    v_recipient_hash := encode(extensions.digest(v_recipient_raw::bytea, 'sha256'), 'hex');
  ELSE
    v_recipient_hash := NULL;
  END IF;

  -- Build the response matching Phase 1.5 frozen schema
  SELECT jsonb_build_object(
    'verified', a.status = 'SECURED',
    'status', v_status_mapped,
    'issuer_name', v_issuer_name,
    'recipient_identifier', COALESCE(v_recipient_hash, ''),
    'credential_type', COALESCE(a.credential_type::text, 'OTHER'),
    'issued_date', a.issued_at,
    'expiry_date', a.expires_at,
    'anchor_timestamp', a.chain_timestamp,
    'bitcoin_block', a.chain_block_height,
    'network_receipt_id', a.chain_tx_id,
    'merkle_proof_hash', NULL,
    'record_uri', 'https://app.arkova.io/verify/' || a.public_id,
    -- Additional fields for UI (not in API frozen schema, but needed by page)
    'public_id', a.public_id,
    'fingerprint', a.fingerprint,
    'filename', a.filename,
    'file_size', a.file_size,
    -- Lifecycle fields for AnchorLifecycleTimeline (P6-TS-04)
    'created_at', a.created_at,
    'secured_at', a.chain_timestamp,
    'issued_at', a.issued_at,
    'revoked_at', a.revoked_at,
    'revocation_reason', a.revocation_reason,
    'expires_at', a.expires_at
  )
  -- Conditionally add jurisdiction only when non-null
  || CASE
       WHEN v_jurisdiction IS NOT NULL
       THEN jsonb_build_object('jurisdiction', v_jurisdiction)
       ELSE '{}'::jsonb
     END
  INTO v_result
  FROM anchors a
  WHERE a.public_id = p_public_id
    AND a.status IN ('SECURED', 'REVOKED', 'EXPIRED')
    AND a.deleted_at IS NULL;

  -- Guard against concurrent status change between the two queries
  IF v_result IS NULL THEN
    RETURN jsonb_build_object('error', 'Record not found or not yet verified');
  END IF;

  RETURN v_result;
END;
$$;

-- Grants remain unchanged — anon and authenticated can call this
GRANT EXECUTE ON FUNCTION get_public_anchor(text) TO anon;
GRANT EXECUTE ON FUNCTION get_public_anchor(text) TO authenticated;


-- ---------------------------------------------------------------------------
-- ROLLBACK: Restore 0044 version (remove lifecycle fields from response)
-- See supabase/migrations/0044_restore_get_public_anchor_phase15.sql
-- ---------------------------------------------------------------------------
