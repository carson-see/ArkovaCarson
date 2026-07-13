BEGIN;

-- =============================================================================
-- 0356 — get_public_anchor recipient_identifier: unsalted sha256 → KEYED HMAC
--        (SCRUM-2484, Sprint 3.25 Lane 2 Security/Privacy)
--
-- WHY THIS EXISTS (offline recipient-enumeration leak):
--   get_public_anchor is GRANTed to anon and projects `recipient_identifier` to
--   anonymous callers. Since 0311 that value was:
--       encode(extensions.digest(v_recipient_raw::bytea, 'sha256'), 'hex')
--   — a BARE, UNSALTED sha256 of the raw recipient (a name/email stored in
--   anchors.metadata->>'recipient'). Because the digest is public AND unkeyed,
--   anyone can compute sha256(known_email) offline and enumerate which anchored
--   credentials belong to a person: a rainbow-table / correlation attack that
--   needs no server secret. (The worker-side sha256(email) was fixed in the same
--   PR stack; this is the SQL-side half.)
--
-- FIX (§1.4, mirrors validate_api_key's extensions.hmac pattern in 0302/0303):
--   Derive recipient_identifier as a KEYED HMAC-SHA256 over the recipient using
--   a server pepper read from the `app.recipient_pepper` GUC — the same DB-level
--   setting mechanism already used for `app.base_url`. Without the pepper the
--   digest cannot be precomputed.
--
--   FAIL CLOSED: when `app.recipient_pepper` is unset/blank, recipient_identifier
--   is returned as '' (empty) — it NEVER falls back to the enumerable bare
--   sha256. An empty identifier is safe (the field stays present per the frozen
--   §1.8 API contract); an enumerable one is the vulnerability.
--
-- CARSON/RTE-GATED (NOT done by this authoring session):
--   * Provisioning the pepper VALUE and applying it DB-side:
--       ALTER DATABASE postgres SET app.recipient_pepper = '<secret>';   -- (or
--       per-role / connection GUC, consistent with how app.base_url is set).
--   * Backfilling existing anchor_recipients.recipient_email_hash rows that were
--     written with the old bare sha256 (0356 does NOT rewrite stored rows — it
--     only changes the on-read projection derivation).
--   Until the pepper is set in prod, recipient_identifier reads as '' for every
--   anchor — a safe, non-leaking default — rather than the old enumerable hash.
--
-- SCOPE: pure CREATE OR REPLACE. Preserves the SCRUM-2485 base-metadata
--   allow-list (0355) verbatim and the full envelope; only the recipient hash
--   derivation at the bottom changed. get_public_anchor_by_fingerprint (0339)
--   delegates and inherits the fix. §1.8: the `recipient_identifier` KEY is
--   unchanged (frozen API contract) — only its VALUE derivation changes, so no
--   API version bump and no types delta.
--
-- TIER: T3 (migrations + security-sensitive anon projection). Prod-apply +
--   pepper provisioning + backfill are RTE/Carson-gated post-soak.
--
-- ROLLBACK: restore the 0355 get_public_anchor definition (whose
--   recipient_identifier was the bare
--   `encode(extensions.digest(v_recipient_raw::bytea, 'sha256'), 'hex')`), then
--   NOTIFY pgrst, 'reload schema'. No stored data is rewritten by this migration,
--   so rollback is a pure function redefinition.
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
  -- SCRUM-2484: server pepper for the recipient-identifier keyed HMAC. Unset ⇒
  -- empty pepper ⇒ empty recipient_identifier (fail closed; never bare sha256).
  v_recipient_pepper text := NULLIF(current_setting('app.recipient_pepper', true), '');
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
      -- (unchanged from 0355 — do not regress to the sanitize_metadata_for_public
      -- denylist pass-through).
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

  -- SCRUM-2484: recipient_identifier = KEYED HMAC-SHA256(pepper, recipient).
  -- FAIL CLOSED: no pepper GUC ⇒ empty identifier (never the enumerable bare
  -- sha256). The key stays present in the payload per the frozen §1.8 contract.
  IF v_recipient_raw IS NOT NULL AND length(v_recipient_raw) > 0 AND v_recipient_pepper IS NOT NULL THEN
    v_recipient_hash := encode(
      extensions.hmac(lower(btrim(v_recipient_raw))::bytea, v_recipient_pepper::bytea, 'sha256'),
      'hex'
    );
    v_result := v_result || jsonb_build_object('recipient_identifier', v_recipient_hash);
  ELSE
    v_result := v_result || jsonb_build_object('recipient_identifier', '');
  END IF;

  RETURN v_result;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMENT ON FUNCTION public.get_public_anchor(p_public_id text)
  IS 'Public anchor projection for anon callers. SCRUM-2485: base metadata is an '
     'explicit allow-list. SCRUM-2484: recipient_identifier is a KEYED HMAC over '
     'app.recipient_pepper (fail closed to '''' when the pepper GUC is unset — '
     'never a bare enumerable sha256). SECURITY DEFINER, search_path=public, '
     'status filter, deleted_at guard preserved.';

COMMIT;
