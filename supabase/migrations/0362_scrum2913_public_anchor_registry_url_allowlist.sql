BEGIN;

-- =============================================================================
-- 0362 — get_public_anchor base metadata allow-list: additive widening to
--        project `registry_url` + `ce_envelope_sha256`
--        (SCRUM-2913, PI-0.5 Lane 2 — the deferred Lane-2 allow-list migration
--         for the Lane-3 CTDL importer #1603)
--
-- WHY THIS EXISTS (Lane 3 handoff):
--   The CTDL JSON-LD importer (#1603 / lane3/scrum-2913-ctdl-importer) maps two
--   fields off imported CTDL evidence into anchors.metadata:
--       registryUrl        -> anchors.metadata->>'registry_url'
--       ceEnvelopeSha256   -> anchors.metadata->>'ce_envelope_sha256'
--   #1603 explicitly DEFERS surfacing these publicly to Lane 2, quoting:
--     "Surfacing registry_url PUBLICLY is out of scope for this PR: it requires a
--      deliberate S2/T3 allow-list migration (Lane 2) + the SCRUM-2485 snapshot
--      test."
--   Since 0355 (SCRUM-2485) rebuilt the base `'metadata'` sub-object of
--   get_public_anchor from a sanitize_metadata_for_public DENYLIST into an
--   EXPLICIT jsonb_build_object + jsonb_strip_nulls ALLOW-LIST, a NEW
--   anchors.metadata key can NEVER auto-project to anonymous callers — it is
--   dropped by default until deliberately added to the allow-list. So the
--   importer can stamp registry_url / ce_envelope_sha256 today, but they stay
--   invisible on the public verification projection until THIS migration widens
--   the allow-list. That deliberate, code-reviewed widening is the whole point.
--
-- WHAT THIS DOES (defense-in-depth preserved; mirrors the 0355/0356 pattern):
--   Pure CREATE OR REPLACE of get_public_anchor, based verbatim on the CURRENT
--   prod-bound definition (0356, which layered the SCRUM-2484 keyed-HMAC
--   recipient_identifier on top of the 0355 allow-list). The ONLY change is two
--   additional keys appended to the base `'metadata'` allow-list:
--       'registry_url',       a.metadata ->> 'registry_url'
--       'ce_envelope_sha256', a.metadata ->> 'ce_envelope_sha256'
--   Sourced with `a.metadata ->>` (direct scalar read), matching the other
--   STRUCTURED allow-list fields (source_id, evidence_schema_version,
--   extraction_manifest_hash, credential_id_hash) rather than the free-form
--   display strings (title/description/…) that go through
--   sanitize_metadata_for_public. jsonb_strip_nulls keeps the additive-nullable
--   shape (§1.8): each key is present only when the stored value is non-null.
--   The key name `ce_envelope_sha256` is used EXACTLY as chosen by Lane 3 to
--   avoid a `registry_envelope` claims-lint collision — do not rename.
--
-- SECURITY / R-7 CLAIMS-GATE REVIEW (§1.4 + §1.13):
--   * PII: neither key is PII. `registry_url` is a Credential Engine registry
--     PROVENANCE link; `ce_envelope_sha256` is a hex integrity fingerprint —
--     consistent with the §1.5 public evidence model (fingerprints ARE the
--     public evidence).
--   * R-7 (no unheld external-status claims): `registry_url` is PROVENANCE
--     ("this anchor's evidence was sourced from this URL"), NOT an assertion that
--     Arkova is listed/registered in the CE Registry. This migration only ALLOWS
--     the key to project; the value is set by the importer (#1603), not here, and
--     the public verification copy must frame it as source provenance, never as
--     registry membership. No CE-listing claim is introduced by this SQL.
--   * Widening is EXACTLY two keys. Every other unlisted anchors.metadata key
--     (registry.ctid, competencyFrameworks, recipient, any future internal) is
--     still dropped by the allow-list. The scrum-2913 snapshot test asserts the
--     exact key set so any accidental over-widening fails CI.
--
-- SCOPE: pure function redefinition. NO schema change, NO new column, NO data
--   migration — registry_url / ce_envelope_sha256 already live inside the
--   existing anchors.metadata jsonb (written by the importer). §1.8
--   additive-nullable — no API version bump. get_public_anchor_by_fingerprint
--   (0339) DELEGATES to get_public_anchor(a.public_id) and inherits this widening
--   automatically.
--
-- TIER: T3 (touches supabase/migrations/ + a security-sensitive anon-GRANTed
--   projection). Prod-apply is RTE/Carson-gated, post-soak, on clean-mirror or
--   isolated staging — NOT applied by this authoring session.
--
-- ROLLBACK: restore the 0356 get_public_anchor definition — identical to the
--   body below but with the base `'metadata'` allow-list WITHOUT the two
--   'registry_url' / 'ce_envelope_sha256' entries (i.e. the 15-key SCRUM-2485
--   allow-list) — then NOTIFY pgrst, 'reload schema'. No stored data is rewritten
--   by this migration, so rollback is a pure function redefinition; on rollback
--   the two keys simply stop projecting (they remain stored in anchors.metadata).
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
      -- (unchanged from 0355/0356 — do not regress to the
      -- sanitize_metadata_for_public denylist pass-through). SCRUM-2913 appends
      -- the two Lane-3 provenance/integrity keys at the end of the allow-list.
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
        'credential_id_hash', a.metadata ->> 'credential_id_hash',
        -- SCRUM-2913 (Lane 2, deferred from #1603): CTDL importer provenance +
        -- integrity. registry_url = CE registry PROVENANCE link (source-of, NOT a
        -- registry-membership claim — R-7 §1.13); ce_envelope_sha256 = hex
        -- integrity fingerprint of the CE envelope (§1.5 evidence model). Read
        -- directly like the other structured allow-list fields; jsonb_strip_nulls
        -- keeps them additive-nullable (§1.8).
        'registry_url', a.metadata ->> 'registry_url',
        'ce_envelope_sha256', a.metadata ->> 'ce_envelope_sha256'
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
     'app.recipient_pepper (fail closed to '''' when unset). SCRUM-2913: base '
     'allow-list widened by registry_url (CE registry PROVENANCE link, not a '
     'membership claim — R-7) + ce_envelope_sha256 (hex integrity fingerprint). '
     'SECURITY DEFINER, search_path=public, status filter, deleted_at guard preserved.';

COMMIT;
