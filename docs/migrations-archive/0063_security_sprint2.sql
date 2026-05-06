-- =============================================================================
-- Migration 0063: Security Sprint 2 — RLS hardening + metadata PII filter
-- Date: 2026-03-16
-- Stories: RLS-04 (anchor_proofs admin-only), PII-04 (metadata PII in public)
--
-- PURPOSE
-- -------
-- 1. Tighten anchor_proofs RLS: restrict SELECT to ORG_ADMIN only.
--    Proof data (chain receipts, signatures) is sensitive operational data
--    that only org admins should access — regular members see anchors, not proofs.
--
-- 2. Add sanitize_metadata_for_public() helper function that strips PII-bearing
--    keys from metadata JSONB before public exposure.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. RLS-04: Restrict anchor_proofs to ORG_ADMIN
-- ---------------------------------------------------------------------------

-- Drop the existing permissive policy (allows any org member)
DROP POLICY IF EXISTS anchor_proofs_read_own ON anchor_proofs;

-- New policy: only ORG_ADMIN can read proof data
CREATE POLICY anchor_proofs_admin_only ON anchor_proofs
  FOR SELECT
  TO authenticated
  USING (
    anchor_id IN (
      SELECT id FROM anchors
      WHERE org_id = get_user_org_id()
    )
    AND is_org_admin()
  );

-- ---------------------------------------------------------------------------
-- 2. PII-04: sanitize_metadata_for_public() — strip PII keys from metadata
-- ---------------------------------------------------------------------------
-- Used by get_public_anchor to ensure no PII leaks through metadata JSONB.
-- Strips: recipient, email, phone, ssn, student_id, address, dob, date_of_birth

CREATE OR REPLACE FUNCTION sanitize_metadata_for_public(p_metadata jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(
    p_metadata
      - 'recipient'
      - 'email'
      - 'phone'
      - 'phone_number'
      - 'ssn'
      - 'social_security'
      - 'student_id'
      - 'student_number'
      - 'address'
      - 'street_address'
      - 'home_address'
      - 'mailing_address'
      - 'dob'
      - 'date_of_birth'
      - 'birthday'
      - 'national_id'
      - 'passport_number'
      - 'drivers_license',
    '{}'::jsonb
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. Update get_public_anchor to use sanitize_metadata_for_public()
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_public_anchor(p_public_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  v_recipient_hash text;
  v_recipient_raw text;
BEGIN
  SELECT
    a.metadata->>'recipient',
    jsonb_build_object(
      'verified', a.status = 'SECURED',
      'status', CASE a.status
        WHEN 'SECURED' THEN 'ACTIVE'
        WHEN 'REVOKED' THEN 'REVOKED'
        WHEN 'EXPIRED' THEN 'EXPIRED'
        WHEN 'PENDING' THEN 'PENDING'
        ELSE a.status::text
      END,
      'issuer_name', COALESCE(a.metadata->>'issuer', o.display_name, 'Unknown Issuer'),
      'credential_type', COALESCE(a.credential_type::text, 'OTHER'),
      'issued_date', a.issued_at,
      'expiry_date', a.expires_at,
      'anchor_timestamp', CASE WHEN a.status != 'PENDING' THEN a.chain_timestamp END,
      'bitcoin_block', CASE WHEN a.status != 'PENDING' THEN a.chain_block_height END,
      'network_receipt_id', CASE WHEN a.status != 'PENDING' THEN a.chain_tx_id END,
      'merkle_proof_hash', NULL::text,
      'record_uri', 'https://app.arkova.io/verify/' || a.public_id,
      'public_id', a.public_id,
      'fingerprint', a.fingerprint,
      'filename', a.filename,
      'file_size', a.file_size,
      'org_id', a.org_id,
      -- PII-04: Use sanitize function instead of just stripping 'recipient'
      'metadata', sanitize_metadata_for_public(COALESCE(a.metadata, '{}'::jsonb)),
      'created_at', a.created_at,
      'secured_at', CASE WHEN a.status != 'PENDING' THEN a.chain_timestamp END,
      'issued_at', a.issued_at,
      'revoked_at', a.revoked_at,
      'revocation_reason', a.revocation_reason,
      'expires_at', a.expires_at
    )
    || CASE
         WHEN a.metadata->>'jurisdiction' IS NOT NULL
         THEN jsonb_build_object('jurisdiction', a.metadata->>'jurisdiction')
         ELSE '{}'::jsonb
       END
  INTO
    v_recipient_raw,
    v_result
  FROM anchors a
  LEFT JOIN organizations o ON o.id = a.org_id
  WHERE a.public_id = p_public_id
    AND a.status IN ('SECURED', 'REVOKED', 'EXPIRED', 'PENDING')
    AND a.deleted_at IS NULL;

  IF v_result IS NULL THEN
    RETURN jsonb_build_object('error', 'Record not found');
  END IF;

  IF v_recipient_raw IS NOT NULL AND v_recipient_raw != '' THEN
    v_recipient_hash := encode(extensions.digest(v_recipient_raw::bytea, 'sha256'), 'hex');
    v_result := v_result || jsonb_build_object('recipient_identifier', v_recipient_hash);
  ELSE
    v_result := v_result || jsonb_build_object('recipient_identifier', '');
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION get_public_anchor(text) TO anon;
GRANT EXECUTE ON FUNCTION get_public_anchor(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- ROLLBACK:
-- DROP POLICY IF EXISTS anchor_proofs_admin_only ON anchor_proofs;
-- Recreate original policy:
-- CREATE POLICY anchor_proofs_read_own ON anchor_proofs
--   FOR SELECT TO authenticated
--   USING (anchor_id IN (SELECT id FROM anchors WHERE user_id = auth.uid() OR org_id = get_user_org_id()));
-- DROP FUNCTION IF EXISTS sanitize_metadata_for_public(jsonb);
-- Restore 0054 version of get_public_anchor
-- ---------------------------------------------------------------------------
