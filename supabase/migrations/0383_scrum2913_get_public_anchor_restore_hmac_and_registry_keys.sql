BEGIN;

-- =============================================================================
-- 0383 — get_public_anchor: restore the SCRUM-2484 keyed HMAC and the
--        SCRUM-2913 allow-list keys that migration 0376 silently reverted.
--
-- THIS IS A COMPENSATING MIGRATION (CLAUDE.md §1.2 — 0376 is applied and is
-- NOT edited). It is a pure CREATE OR REPLACE of one function. No schema
-- change, no column, no data rewrite.
--
-- -----------------------------------------------------------------------------
-- WHAT WENT WRONG
-- -----------------------------------------------------------------------------
-- `get_public_anchor` has been redefined by a chain of migrations:
--   0355 (SCRUM-2485) — rebuilt the base `metadata` sub-object from a
--        sanitize_metadata_for_public DENYLIST into an explicit ALLOW-LIST.
--   0356 (SCRUM-2484) — replaced the bare SHA-256 `recipient_identifier` with a
--        KEYED HMAC over the `app.recipient_pepper` GUC, FAIL-CLOSED to '' when
--        the pepper is unset.
--   0362 (SCRUM-2913) — widened the allow-list by `registry_url` +
--        `ce_envelope_sha256`.
--   0376 (R19)        — added the top-level `fingerprint_source` key.
--
-- 0376's own header says its body is "otherwise IDENTICAL to 0355's
-- definition". That is exactly the defect: it was branched from 0355 rather
-- than from the then-current head, so its CREATE OR REPLACE silently discarded
-- BOTH 0356 and 0362. Because `CREATE OR REPLACE FUNCTION` overwrites the whole
-- body, nothing failed and nothing warned — the ledger shows 0356 and 0362
-- applied, while their effects were gone from the live function.
--
-- VERIFIED LIVE on prod `vzwyaatejekddvltxyye` 2026-08-01 via
-- `pg_get_functiondef`, i.e. this is the state in production right now:
--   * recipient_identifier is computed as
--       encode(extensions.digest(v_recipient_raw::bytea, 'sha256'), 'hex')
--     — the pre-0356 BARE SHA-256. The `app.recipient_pepper` GUC is UNSET
--     (`current_setting` → NULL, 0 rows in pg_db_role_setting), so before 0376
--     this field was correctly returning '' and it now returns a live,
--     unsalted, ENUMERABLE hash of the recipient identifier on an
--     anon-callable endpoint. That is the precise attack 0356 was written to
--     close: the recipient value is a low-entropy identifier (typically an
--     email address), so an unsalted SHA-256 is reversible by dictionary or
--     rainbow-table attack against a public API.
--   * `registry_url` / `ce_envelope_sha256` are absent from the allow-list, so
--     the SCRUM-2913 public projection has been inert since 0376 applied.
--
-- -----------------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES
-- -----------------------------------------------------------------------------
-- Redefines `get_public_anchor` as the UNION of every change that was supposed
-- to be in effect — the correct head state:
--   * KEEPS 0376's top-level `fingerprint_source` key (R19 — unchanged).
--   * KEEPS 0355's explicit allow-list shape (no denylist regression).
--   * RESTORES 0356's keyed-HMAC `recipient_identifier`, fail-closed to '' when
--     `app.recipient_pepper` is unset. With the pepper still unset this returns
--     the SAME '' that shipped between 0356 (2026-07-13) and 0376 (2026-07-28),
--     so this is a restoration of the previously-shipped contract, not a new
--     behaviour. The key stays present in the payload either way (§1.8 frozen
--     schema — the field is never dropped, only emptied).
--   * RESTORES 0362's two allow-list keys `registry_url` +
--     `ce_envelope_sha256`.
--
-- SECURITY / §1.5 / R-7 NOTES (carried forward from 0362, still true):
--   * Neither restored key is PII. `registry_url` is Credential Engine registry
--     PROVENANCE ("this anchor's evidence was sourced from this URL"), NOT a
--     claim that Arkova is listed or endorsed by the CE Registry (R-7 §1.13);
--     `ce_envelope_sha256` is a hex integrity fingerprint (§1.5 — fingerprints
--     ARE the public evidence).
--   * The widening is EXACTLY two keys. Every other `anchors.metadata` key
--     (registry.ctid, competencyFrameworks, recipient, any future internal
--     field) is still dropped by the allow-list.
--   * SECURITY DEFINER, `SET search_path = public`, the status filter and the
--     `deleted_at` guard are all preserved verbatim.
--   * Only `public_id` and derived fields are projected — no `user_id`,
--     `org_id`, or `anchors.id` (CLAUDE.md §6).
--
-- LESSON FOR THE NEXT AUTHOR: `get_public_anchor` is redefined wholesale by
-- every migration that touches it. NEVER branch its body from an older
-- migration file. Take `pg_get_functiondef` from prod (or the highest-numbered
-- migration that redefines it), diff your change against THAT, and state in the
-- header which definition you based on.
--
-- ROLLBACK: restore the 0376 definition — the body below with the
--   `v_recipient_pepper` declaration removed, the recipient block reverted to
--   `encode(extensions.digest(v_recipient_raw::bytea, 'sha256'), 'hex')`, and
--   the `registry_url` / `ce_envelope_sha256` allow-list entries removed — then
--   `NOTIFY pgrst, 'reload schema';`. No stored data is rewritten by this
--   migration, so rollback is a pure function redefinition; the two keys simply
--   stop projecting (they remain stored in anchors.metadata) and
--   recipient_identifier reverts to the bare hash. NOTE that rolling back
--   REOPENS the enumeration hole described above.
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
  -- SCRUM-2484 (restored): server pepper for the recipient-identifier keyed
  -- HMAC. Unset ⇒ empty pepper ⇒ empty recipient_identifier (fail closed;
  -- never a bare, enumerable sha256).
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
      -- R19 / 0376 (preserved): additive-nullable top-level key (§1.8). NULL for
      -- anchors predating 0376 ("unclassified" — see column COMMENT).
      'fingerprint_source', a.fingerprint_source,
      'filename', a.filename,
      'file_size', a.file_size,
      'issuer_public_id', o.public_id,
      -- SCRUM-2485 / 0355 (preserved): EXPLICIT public allow-list for the base
      -- metadata sub-object. Do NOT regress to the sanitize_metadata_for_public
      -- denylist pass-through — a new anchors.metadata key must never
      -- auto-project to anonymous callers.
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
        -- SCRUM-2913 / 0362 (RESTORED): CTDL importer provenance + integrity.
        -- registry_url = CE registry PROVENANCE link (source-of, NOT a
        -- registry-membership claim — R-7 §1.13); ce_envelope_sha256 = hex
        -- integrity fingerprint of the CE envelope (§1.5 evidence model). Read
        -- directly like the other structured allow-list fields;
        -- jsonb_strip_nulls keeps them additive-nullable (§1.8).
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

  -- SCRUM-2484 (RESTORED): recipient_identifier = KEYED HMAC-SHA256(pepper,
  -- recipient). FAIL CLOSED: no pepper GUC ⇒ empty identifier, never the
  -- enumerable bare sha256. The key stays present in the payload per the frozen
  -- §1.8 contract.
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
  IS 'Public anchor projection for anon callers. HEAD STATE as of 0383 — the '
     'union of 0355 (explicit metadata allow-list), 0356 (keyed-HMAC '
     'recipient_identifier over app.recipient_pepper, fail-closed to '''' when '
     'unset), 0362 (allow-list widened by registry_url = CE registry PROVENANCE '
     'link, not a membership claim (R-7), + ce_envelope_sha256 = hex integrity '
     'fingerprint) and 0376 (additive-nullable top-level fingerprint_source). '
     '0376 had branched from 0355 and silently reverted 0356 + 0362; 0383 '
     'restores them. SECURITY DEFINER, search_path=public, status filter and '
     'deleted_at guard preserved. WARNING: this function is redefined wholesale '
     'by every migration that touches it — always base a new definition on the '
     'CURRENT one (pg_get_functiondef), never on an older migration file.';

COMMIT;
