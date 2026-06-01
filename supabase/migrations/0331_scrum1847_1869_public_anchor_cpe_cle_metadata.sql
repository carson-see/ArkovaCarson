-- SCRUM-1847 (CPE-R1) + SCRUM-1869 (CLE-R1): complete the PUBLIC verification
-- display path for Continuing Professional Education and Continuing Legal
-- Education credit metadata.
--
-- WHY: The public verify path (src/components/verification/PublicVerification.tsx
-- and src/components/embed/VerificationWidget.tsx) calls get_public_anchor
-- directly via the Supabase anon client and assigns the whole RPC result to the
-- public anchor object — a passthrough, NOT a worker-mediated allowlist. The
-- frontend (open draft PRs #1023/#1025) already reads data.cpe_metadata /
-- data.cle_metadata and self-hides when absent, but the RPC has never returned
-- those fields, so the CPE/CLE R1 public display is dark. This adds them,
-- surfaced from the existing anchors.cpe_metadata / anchors.cle_metadata jsonb
-- columns (added in 0315_professional_education_foundations.sql).
--
-- These are ADDITIVE NULLABLE fields (CLAUDE.md §1.8) — no API version bump.
-- NULL is returned when the column is NULL (extraction is new; ~0 prod anchors
-- carry this metadata today — the path is built ahead of the data).
--
-- DEFENSE IN DEPTH (§1.4): the internal extraction signals
-- 'extraction_confidence' and 'extraction_source' are stripped server-side
-- (jsonb '-' key removal) so they can never reach the public payload even if a
-- client forgets to allowlist them. This matches the frontend display allowlist.
-- Everything else in get_public_anchor is reproduced byte-identical to the
-- live prod definition (SECURITY DEFINER, search_path, status filter,
-- deleted_at guard, sanitized metadata, recipient-identifier SHA-256 hash).
--
-- ROLLBACK: restore the prior get_public_anchor body — i.e. re-run the
-- definition from 0311_scrum1599_public_anchor_provenance.sql (the immediately
-- prior CREATE OR REPLACE of this function), which omits the cpe_metadata /
-- cle_metadata keys. No data migration is involved; this is a pure function
-- redefinition. After rollback run: NOTIFY pgrst, 'reload schema';

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
      'fetched_at', COALESCE(a.metadata->>'fetched_at', a.metadata->>'source_fetched_at'),
      -- SCRUM-1847 (CPE-R1): structured CPE compliance metadata, with internal
      -- extraction signals stripped server-side (defense in depth, §1.4).
      'cpe_metadata', CASE
        WHEN a.cpe_metadata IS NOT NULL
        THEN (a.cpe_metadata - 'extraction_confidence' - 'extraction_source')
        ELSE NULL
      END,
      -- SCRUM-1869 (CLE-R1): structured CLE compliance metadata, same strip.
      'cle_metadata', CASE
        WHEN a.cle_metadata IS NOT NULL
        THEN (a.cle_metadata - 'extraction_confidence' - 'extraction_source')
        ELSE NULL
      END
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
  IS 'Returns redacted anchor info for public verification with CSI-03 source provenance and CPE/CLE compliance metadata (SCRUM-1847/1869). cpe_metadata/cle_metadata strip extraction_confidence + extraction_source server-side. Returns SECURED/ACTIVE, REVOKED, EXPIRED, SUPERSEDED, PENDING, SUBMITTED.';
