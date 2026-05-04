-- =============================================================================
-- Migration 0054: Public template RPC + PENDING anchor support
-- Date: 2026-03-16
-- Stories: UF-01 (Template Rendering), UF-04 (PENDING Status UX)
--
-- PURPOSE
-- -------
-- 1. get_public_template RPC: Returns template display data (name + fields)
--    for public verification pages. SECURITY DEFINER so anon can call it.
--    Only exposes name + default_metadata — no internal org data.
--
-- 2. Updated get_public_anchor: Now includes PENDING anchors so public
--    verification shows "Anchoring In Progress" instead of "Not Found".
--    PENDING anchors exclude chain-specific fields (chain_tx_id, etc.)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. get_public_template: Fetch template display config for public rendering
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_public_template(
  p_credential_type text,
  p_org_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'name', ct.name,
    'default_metadata', ct.default_metadata
  )
  INTO v_result
  FROM credential_templates ct
  WHERE ct.org_id = p_org_id
    AND ct.credential_type = p_credential_type::credential_type
    AND ct.is_active = true
  LIMIT 1;

  -- Return null if no template found (caller handles fallback)
  RETURN v_result;
END;
$$;

-- Allow anon + authenticated to call
GRANT EXECUTE ON FUNCTION get_public_template(text, uuid) TO anon;
GRANT EXECUTE ON FUNCTION get_public_template(text, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Updated get_public_anchor: Include PENDING status
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
  -- Single read: fetch the anchor row with all needed fields in one query
  -- Now includes PENDING status (UF-04)
  SELECT
    a.metadata->>'recipient',
    jsonb_build_object(
      -- Phase 1.5 frozen schema fields
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
      -- PENDING anchors don't have chain data yet
      'anchor_timestamp', CASE WHEN a.status != 'PENDING' THEN a.chain_timestamp END,
      'bitcoin_block', CASE WHEN a.status != 'PENDING' THEN a.chain_block_height END,
      'network_receipt_id', CASE WHEN a.status != 'PENDING' THEN a.chain_tx_id END,
      'merkle_proof_hash', NULL::text,
      'record_uri', 'https://app.arkova.io/verify/' || a.public_id,
      -- Additional fields for UI (not in API frozen schema, but needed by page)
      'public_id', a.public_id,
      'fingerprint', a.fingerprint,
      'filename', a.filename,
      'file_size', a.file_size,
      -- Template lookup fields (UF-01)
      'org_id', a.org_id,
      -- Anchor metadata for CredentialRenderer (PII-stripped: remove recipient)
      'metadata', COALESCE(a.metadata, '{}'::jsonb) - 'recipient',
      -- Lifecycle fields for AnchorLifecycleTimeline (P6-TS-04)
      'created_at', a.created_at,
      'secured_at', CASE WHEN a.status != 'PENDING' THEN a.chain_timestamp END,
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
    AND a.status IN ('SECURED', 'REVOKED', 'EXPIRED', 'PENDING')
    AND a.deleted_at IS NULL;

  -- Not found
  IF v_result IS NULL THEN
    RETURN jsonb_build_object('error', 'Record not found');
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
-- ROLLBACK:
-- DROP FUNCTION IF EXISTS get_public_template(text, uuid);
-- Restore 0048 version of get_public_anchor (without PENDING, without metadata/org_id)
-- ---------------------------------------------------------------------------
