BEGIN;

-- =============================================================================
-- 0355 — get_public_anchor base metadata projection: DENYLIST → ALLOW-LIST
--        (SCRUM-2485, Sprint 3.25 Lane 2 Security/Privacy)
--
-- WHY THIS EXISTS (public-by-default metadata leak class):
--   get_public_anchor is GRANTed to anon and is called directly by the public
--   verification page + the /api/v1/verify edge path. Its TOP-LEVEL keys are an
--   explicit jsonb_build_object allow-list, and 0331 gave cpe_metadata /
--   cle_metadata explicit allow-lists too. But the base `'metadata'` sub-object
--   was still built as:
--       'metadata', sanitize_metadata_for_public(COALESCE(a.metadata, '{}'))
--   sanitize_metadata_for_public is a DENYLIST (0334): it strips a fixed set of
--   named PII keys + every `_`-prefixed worker/chain internal, and PASSES THROUGH
--   EVERYTHING ELSE. So the moment the anchoring pipeline starts stamping a new
--   top-level metadata key (e.g. registry.ctid, competencyFrameworks, or any
--   future field), that key AUTO-PROJECTS to anonymous callers with no code
--   review — the exact public-by-default exposure this ticket closes.
--
-- FIX (defense in depth, §1.4; mirrors the proven 0331 CPE/CLE pattern):
--   Rebuild the `'metadata'` sub-object from an EXPLICIT jsonb_build_object +
--   jsonb_strip_nulls ALLOW-LIST of only the safe public display keys. A NEW,
--   unlisted key can never project — adding a public key now requires editing
--   BOTH this allow-list AND the snapshot test (scrum-2485), which is the point.
--   sanitize_metadata_for_public is still applied to the free-form string values
--   as defense in depth (so an allow-listed key that ever carried a PII-shaped
--   VALUE is still scrubbed), but it is no longer the base pass-through.
--
--   The allow-list = the genuinely-public display keys currently in use:
--     * generic UI fields: title, credential_title, description, category,
--       proof_url, issuer, jurisdiction
--     * source-import evidence metadata that is NOT already promoted to a
--       dedicated top-level get_public_anchor key: evidence_schema_version,
--       source_id, source_payload_content_type, source_payload_byte_length,
--       extraction_method, extraction_manifest_hash, extraction_confidence,
--       credential_id_hash
--   (source_url / source_provider / verification_level / evidence_package_hash /
--    source_payload_hash / fetched_at / source_fetched_at are already surfaced as
--    dedicated top-level keys and are `-`'d off the input, so they are NOT in the
--    sub-object allow-list — no double projection.)
--
-- NOTE: `issuer` + `jurisdiction` also appear at top-level (issuer_name /
--   jurisdiction). Keeping them inside the metadata sub-object too preserves the
--   frontend's generic key/value metadata renderer (PublicVerification.tsx
--   sanitizeCredentialMetadata) which reads them from data.metadata; harmless
--   duplication, no consumer breakage.
--
-- SCOPE: pure CREATE OR REPLACE of the function body — no schema change, no data
--   migration. get_public_anchor_by_fingerprint (0339) DELEGATES to
--   get_public_anchor(a.public_id) and inherits this fix automatically. §1.8
--   additive-nullable (a projected key is present only when the stored value is
--   non-null) — no API version bump.
--
-- SECURITY ENVELOPE (unchanged from 0331): SECURITY DEFINER + SET search_path =
--   public + status filter + deleted_at guard + recipient hash. Only the
--   `'metadata'` sub-object build changed.
--
-- TIER: T3 (touches supabase/migrations/ + a security-sensitive anon-GRANTed
--   projection). Prod-apply is RTE/Carson-gated, post-soak, on clean-mirror or
--   isolated staging — NOT applied by this authoring session.
--
-- ROLLBACK: restore the prior get_public_anchor definition from 0331
--   (0331_scrum1847_1869_public_anchor_cpe_cle_metadata.sql), whose `'metadata'`
--   sub-key was:
--     'metadata', sanitize_metadata_for_public(
--        COALESCE(a.metadata, '{}'::jsonb)
--          - 'pipeline_source' - 'source_url' - 'source_provider'
--          - 'verification_level' - 'evidence_package_hash'
--          - 'source_payload_hash' - 'fetched_at' - 'source_fetched_at'),
--   then NOTIFY pgrst, 'reload schema'. No data migration to reverse.
-- =============================================================================

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
      -- SCRUM-2485: EXPLICIT public allow-list for the base metadata sub-object
      -- (replaces the sanitize_metadata_for_public DENYLIST pass-through). Only
      -- the keys named here project; any NEW anchors.metadata key (registry.ctid,
      -- competencyFrameworks, or any future internal) is dropped by default.
      -- Values are still run through sanitize_metadata_for_public as defense in
      -- depth so an allow-listed key that ever holds a PII-shaped VALUE is
      -- scrubbed. jsonb_strip_nulls keeps the additive-nullable shape (§1.8): a
      -- sub-key is present only when the stored value is non-null. Sourced with
      -- ->> for scalar display strings; numeric-ish keys (byte_length,
      -- confidence) are read as text and rendered null-tolerantly by the
      -- frontend, matching PublicCredentialEvidenceMetadataSchema.
      'metadata', jsonb_strip_nulls(jsonb_build_object(
        'title', (sanitize_metadata_for_public(COALESCE(a.metadata, '{}'::jsonb))) ->> 'title',
        'credential_title', (sanitize_metadata_for_public(COALESCE(a.metadata, '{}'::jsonb))) ->> 'credential_title',
        'description', (sanitize_metadata_for_public(COALESCE(a.metadata, '{}'::jsonb))) ->> 'description',
        'category', (sanitize_metadata_for_public(COALESCE(a.metadata, '{}'::jsonb))) ->> 'category',
        'proof_url', (sanitize_metadata_for_public(COALESCE(a.metadata, '{}'::jsonb))) ->> 'proof_url',
        'issuer', (sanitize_metadata_for_public(COALESCE(a.metadata, '{}'::jsonb))) ->> 'issuer',
        'jurisdiction', a.metadata ->> 'jurisdiction',
        'evidence_schema_version', a.metadata ->> 'evidence_schema_version',
        'source_id', a.metadata ->> 'source_id',
        'source_payload_content_type', a.metadata ->> 'source_payload_content_type',
        'source_payload_byte_length', a.metadata ->> 'source_payload_byte_length',
        'extraction_method', a.metadata ->> 'extraction_method',
        'extraction_manifest_hash', a.metadata ->> 'extraction_manifest_hash',
        'extraction_confidence', a.metadata ->> 'extraction_confidence',
        'credential_id_hash', a.metadata ->> 'credential_id_hash'
      )),
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
      -- SCRUM-1847 (CPE-R1): structured CPE compliance metadata, EXPLICIT public
      -- allow-list (unchanged from 0331).
      'cpe_metadata', CASE
        WHEN a.cpe_metadata IS NOT NULL
        THEN jsonb_strip_nulls(jsonb_build_object(
          'credit_hours', a.cpe_metadata -> 'credit_hours',
          'field_of_study', a.cpe_metadata -> 'field_of_study',
          'delivery_method', a.cpe_metadata -> 'delivery_method',
          'nasba_status', a.cpe_metadata -> 'nasba_status',
          'nasba_lookup_date', a.cpe_metadata -> 'nasba_lookup_date',
          'requires_manual_review', a.cpe_metadata -> 'requires_manual_review'
        ))
        ELSE NULL
      END,
      -- SCRUM-1869 (CLE-R1): structured CLE compliance metadata, EXPLICIT public
      -- allow-list (unchanged from 0331).
      'cle_metadata', CASE
        WHEN a.cle_metadata IS NOT NULL
        THEN jsonb_strip_nulls(jsonb_build_object(
          'credit_hours', a.cle_metadata -> 'credit_hours',
          'ethics_hours', a.cle_metadata -> 'ethics_hours',
          'jurisdiction', a.cle_metadata -> 'jurisdiction',
          'approved_provider_name', a.cle_metadata -> 'approved_provider_name',
          'provider_approval_status', a.cle_metadata -> 'provider_approval_status',
          'provider_lookup_date', a.cle_metadata -> 'provider_lookup_date',
          'delivery_format', a.cle_metadata -> 'delivery_format',
          'course_title', a.cle_metadata -> 'course_title',
          'requires_manual_review', a.cle_metadata -> 'requires_manual_review'
        ))
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

  -- SCRUM-2484 (separate PR): this recipient_identifier is an UNSALTED
  -- sha256(recipient) and is replaced there with a keyed HMAC. Left byte-for-byte
  -- identical here so this projection-allow-list migration is scoped to SCRUM-2485
  -- only and the two changes do not entangle.
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
  IS 'Public anchor projection for anon callers. SCRUM-2485: base metadata '
     'sub-object is an EXPLICIT jsonb_build_object allow-list (not the '
     'sanitize_metadata_for_public denylist pass-through) so a new anchors.metadata '
     'key cannot auto-project. SECURITY DEFINER, search_path=public, status filter, '
     'deleted_at guard preserved.';

COMMIT;
