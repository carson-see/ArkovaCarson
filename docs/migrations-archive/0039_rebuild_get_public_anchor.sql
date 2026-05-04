-- =============================================================================
-- Migration 0039: Rebuild get_public_anchor RPC — Phase 1.5 frozen schema
-- Date: 2026-03-10
--
-- PURPOSE
-- -------
-- The existing get_public_anchor (migration 0020) returns 8 fields.
-- P6-TS-01 requires the full Phase 1.5 frozen response schema with 14 fields:
--   verified, status, issuer_name, recipient_identifier, credential_type,
--   issued_date, expiry_date, anchor_timestamp, bitcoin_block,
--   network_receipt_id, merkle_proof_hash, record_uri, jurisdiction,
--   plus filename and fingerprint for the UI.
--
-- STATUS MAPPING
-- -------
-- Internal DB status → Public API status:
--   SECURED → ACTIVE
--   REVOKED → REVOKED
--   EXPIRED → EXPIRED
--   PENDING → (not returned — filtered out)
--
-- SUPERSEDED is not yet implemented in the DB enum but is reserved.
--
-- SECURITY NOTES
-- -------
-- - SECURITY DEFINER: bypasses RLS for the lookup (public access).
-- - SET search_path = public: prevents search path injection.
-- - recipient_identifier is SHA-256 hashed — never raw PII.
-- - user_id, org_id, anchors.id are never exposed.
-- - jurisdiction is omitted from response when null (not returned as null).
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. Ensure pgcrypto is available for digest() — must come before function
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;


-- ---------------------------------------------------------------------------
-- 2. Rebuild get_public_anchor() with expanded schema
-- ---------------------------------------------------------------------------
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
    'file_size', a.file_size
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
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- Revert to the original 8-field version from migration 0020:
--
-- CREATE OR REPLACE FUNCTION get_public_anchor(p_public_id text)
-- RETURNS jsonb
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- SET search_path = public
-- AS $$
-- DECLARE
--   v_result jsonb;
-- BEGIN
--   SELECT jsonb_build_object(
--     'public_id', a.public_id,
--     'fingerprint', a.fingerprint,
--     'status', a.status,
--     'filename', a.filename,
--     'file_size', a.file_size,
--     'secured_at', a.chain_timestamp,
--     'network_receipt', a.chain_tx_id,
--     'verified', a.status = 'SECURED'
--   )
--   INTO v_result
--   FROM anchors a
--   WHERE a.public_id = p_public_id
--     AND a.status = 'SECURED'
--     AND a.deleted_at IS NULL;
--
--   IF v_result IS NULL THEN
--     RETURN jsonb_build_object('error', 'Anchor not found or not verified');
--   END IF;
--
--   RETURN v_result;
-- END;
-- $$;
