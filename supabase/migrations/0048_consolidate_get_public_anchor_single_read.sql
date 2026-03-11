-- =============================================================================
-- Migration 0048: Consolidate get_public_anchor to single-read CTE
-- Date: 2026-03-11
--
-- PURPOSE
-- -------
-- CodeRabbit + SonarCloud flagged the double-read pattern (two SELECT queries
-- on the same row) as a reliability risk. A concurrent status change between
-- the two reads could yield inconsistent results.
--
-- This migration rewrites get_public_anchor to use a single CTE that reads the
-- row once and builds the full response from that single read.
--
-- Also extracts duplicated string literals ('SECURED', 'REVOKED', 'EXPIRED')
-- into the CASE expressions to reduce SonarCloud duplication findings.
-- =============================================================================

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
  -- Single read: fetch the anchor row with all needed fields in one query
  SELECT
    a.metadata->>'recipient',
    jsonb_build_object(
      -- Phase 1.5 frozen schema fields
      'verified', a.status = 'SECURED',
      'status', CASE a.status
        WHEN 'SECURED' THEN 'ACTIVE'
        WHEN 'REVOKED' THEN 'REVOKED'
        WHEN 'EXPIRED' THEN 'EXPIRED'
        ELSE a.status::text
      END,
      'issuer_name', COALESCE(a.metadata->>'issuer', o.display_name, 'Unknown Issuer'),
      'credential_type', COALESCE(a.credential_type::text, 'OTHER'),
      'issued_date', a.issued_at,
      'expiry_date', a.expires_at,
      'anchor_timestamp', a.chain_timestamp,
      'bitcoin_block', a.chain_block_height,
      'network_receipt_id', a.chain_tx_id,
      'merkle_proof_hash', NULL::text,
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
    AND a.status IN ('SECURED', 'REVOKED', 'EXPIRED')
    AND a.deleted_at IS NULL;

  -- Not found
  IF v_result IS NULL THEN
    RETURN jsonb_build_object('error', 'Record not found or not yet verified');
  END IF;

  -- Hash the recipient identifier (SHA-256) — never expose raw PII
  IF v_recipient_raw IS NOT NULL AND v_recipient_raw != '' THEN
    v_recipient_hash := encode(extensions.digest(v_recipient_raw::bytea, 'sha256'), 'hex');
    v_result := v_result || jsonb_build_object('recipient_identifier', v_recipient_hash);
  ELSE
    v_result := v_result || jsonb_build_object('recipient_identifier', '');
  END IF;

  RETURN v_result;
END;
$$;

-- Grants remain unchanged — anon and authenticated can call this
GRANT EXECUTE ON FUNCTION get_public_anchor(text) TO anon;
GRANT EXECUTE ON FUNCTION get_public_anchor(text) TO authenticated;


-- ---------------------------------------------------------------------------
-- ROLLBACK: Restore 0047 version (two-read pattern with lifecycle fields)
-- CREATE OR REPLACE FUNCTION get_public_anchor(p_public_id text)
-- RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
-- AS $$ ... $$;  -- See supabase/migrations/0047_add_lifecycle_fields_to_get_public_anchor.sql
-- ---------------------------------------------------------------------------
