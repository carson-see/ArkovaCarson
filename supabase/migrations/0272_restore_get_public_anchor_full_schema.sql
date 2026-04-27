-- =============================================================================
-- Migration 0272: Restore get_public_anchor full Phase 1.5 schema
--
-- Migration 0121 (get_public_anchor_submitted_status, 2026-03-26) had the
-- comprehensive version of this RPC: 23 fields including the Phase 1.5
-- frozen schema (verified, status mapping, issuer_name, credential_type,
-- issued_date, expiry_date, anchor_timestamp, bitcoin_block,
-- network_receipt_id, merkle_proof_hash, record_uri, jurisdiction),
-- recipient_identifier hashing, metadata sanitization, and full status
-- coverage (SECURED, REVOKED, EXPIRED, PENDING, SUBMITTED).
--
-- Migration 0174 (public_verification_revoked) was scoped to "add REVOKED
-- anchors" but actually replaced the whole function body with a stripped
-- 8-field version that:
--   - Removed status mapping (returns raw 'SECURED' instead of 'ACTIVE')
--   - Removed PENDING / EXPIRED / SUBMITTED from the WHERE clause
--   - Removed issuer_name, credential_type, issued_date, expiry_date,
--     anchor_timestamp, bitcoin_block, network_receipt_id,
--     merkle_proof_hash, record_uri, jurisdiction, metadata, recipient
--     hashing, lifecycle timestamps
--   - Returns hard error for any non-SECURED/REVOKED anchor instead of
--     the verified=false envelope
--
-- 0121 already returned REVOKED anchors — 0174 was effectively a regression
-- with no real benefit, likely authored against a pre-0121 version of the
-- function and merged without rebasing.
--
-- The P7-S7 RLS tests catch 2 of the visible regressions (status mapping
-- and PENDING handling). Real-world impact is broader: the public verify
-- page (`/verify/<public_id>`) has been showing 8 fields instead of 14
-- since 0174 landed, missing all Phase 1.5 frozen-schema fields that the
-- HakiChain audit-evidence integration depends on.
--
-- This migration restores the 0121 body verbatim. No new behavior; just
-- undoes the accidental regression.
--
-- ROLLBACK
-- --------
-- DROP FUNCTION + recreate the 0174 stripped version. Don't — that's the
-- regression we're fixing.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_public_anchor(p_public_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
        WHEN 'SUBMITTED' THEN 'SUBMITTED'
        ELSE a.status::text
      END,
      'issuer_name', COALESCE(a.metadata->>'issuer', o.display_name, 'Unknown Issuer'),
      'credential_type', COALESCE(a.credential_type::text, 'OTHER'),
      'issued_date', a.issued_at,
      'expiry_date', a.expires_at,
      'anchor_timestamp', CASE WHEN a.status NOT IN ('PENDING') THEN a.chain_timestamp END,
      'bitcoin_block', CASE WHEN a.status NOT IN ('PENDING') THEN a.chain_block_height END,
      'network_receipt_id', CASE WHEN a.status NOT IN ('PENDING') THEN a.chain_tx_id END,
      'merkle_proof_hash', NULL::text,
      'record_uri', 'https://app.arkova.io/verify/' || a.public_id,
      'public_id', a.public_id,
      'fingerprint', a.fingerprint,
      'filename', a.filename,
      'file_size', a.file_size,
      'org_id', a.org_id,
      'metadata', sanitize_metadata_for_public(COALESCE(a.metadata, '{}'::jsonb)),
      'created_at', a.created_at,
      'secured_at', CASE WHEN a.status NOT IN ('PENDING') THEN a.chain_timestamp END,
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
    AND a.status IN ('SECURED', 'REVOKED', 'EXPIRED', 'PENDING', 'SUBMITTED')
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
$function$;

-- Grants from 0174 are preserved — anon and authenticated still have EXECUTE.
GRANT EXECUTE ON FUNCTION get_public_anchor(text) TO anon;
GRANT EXECUTE ON FUNCTION get_public_anchor(text) TO authenticated;

COMMENT ON FUNCTION get_public_anchor IS
  'Returns redacted anchor info for public verification (Phase 1.5 frozen '
  'schema). Returns SECURED, REVOKED, EXPIRED, PENDING, SUBMITTED. PENDING '
  'is exposed with verified=false so the public page can show '
  '"awaiting confirmation" instead of "not found".';

NOTIFY pgrst, 'reload schema';

COMMIT;
