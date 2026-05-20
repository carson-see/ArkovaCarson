-- SCRUM-1599: expose public-safe source provenance and SUPERSEDED state.
-- Rollback: restore the previous get_public_anchor body from
-- 00000000000000_baseline_at_main_HEAD.sql.

CREATE OR REPLACE FUNCTION public.get_public_anchor(p_public_id text) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_result jsonb;
  v_recipient_hash text;
  v_recipient_raw text;
  v_app_base_url text := COALESCE(NULLIF(current_setting('app.base_url', true), ''), 'https://app.arkova.ai');
BEGIN
  SELECT
    a.metadata->>'recipient',
    jsonb_build_object(
      'verified', a.status = 'SECURED',
      'status', CASE a.status
        WHEN 'SECURED' THEN 'ACTIVE'
        WHEN 'REVOKED' THEN 'REVOKED'
        WHEN 'EXPIRED' THEN 'EXPIRED'
        WHEN 'SUPERSEDED' THEN 'SUPERSEDED'
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
      'record_uri', v_app_base_url || '/verify/' || a.public_id,
      'public_id', a.public_id,
      'fingerprint', a.fingerprint,
      'filename', a.filename,
      'file_size', a.file_size,
      'issuer_public_id', o.public_id,
      'metadata', sanitize_metadata_for_public(
        COALESCE(a.metadata, '{}'::jsonb)
          - 'pipeline_source'
          - 'source_url'
          - 'source_provider'
          - 'verification_level'
          - 'evidence_package_hash'
          - 'source_payload_hash'
          - 'fetched_at'
          - 'source_fetched_at'
      ),
      'created_at', a.created_at,
      'secured_at', CASE WHEN a.status NOT IN ('PENDING') THEN a.chain_timestamp END,
      'issued_at', a.issued_at,
      'revoked_at', a.revoked_at,
      'superseded_at', CASE WHEN a.status = 'SUPERSEDED' THEN a.revoked_at END,
      'revocation_reason', a.revocation_reason,
      'expires_at', a.expires_at,
      'source_url', regexp_replace(split_part(a.metadata->>'source_url', '#', 1), '\?.*$', ''),
      'source_provider', a.metadata->>'source_provider',
      'verification_level', a.metadata->>'verification_level',
      'evidence_package_hash', a.metadata->>'evidence_package_hash',
      'source_payload_hash', a.metadata->>'source_payload_hash',
      'fetched_at', COALESCE(a.metadata->>'fetched_at', a.metadata->>'source_fetched_at')
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
    AND a.status IN ('SECURED', 'REVOKED', 'EXPIRED', 'SUPERSEDED', 'PENDING', 'SUBMITTED')
    AND a.deleted_at IS NULL;

  IF v_result IS NULL THEN
    RETURN jsonb_build_object('error', 'Record not found');
  END IF;

  IF v_recipient_raw IS NOT NULL AND length(v_recipient_raw) > 0 THEN
    v_recipient_hash := encode(extensions.digest(v_recipient_raw::bytea, 'sha256'), 'hex');
    v_result := v_result || jsonb_build_object('recipient_identifier', v_recipient_hash);
  ELSE
    v_result := v_result || jsonb_build_object('recipient_identifier', '');
  END IF;

  RETURN v_result;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMENT ON FUNCTION public.get_public_anchor(p_public_id text)
  IS 'Returns redacted anchor info for public verification with CSI-03 source provenance. Returns SECURED/ACTIVE, REVOKED, EXPIRED, SUPERSEDED, PENDING, SUBMITTED.';
