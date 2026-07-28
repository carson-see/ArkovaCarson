-- 0375_r19_anchor_fingerprint_source.sql
-- CTO ruling R19 (2026-07-28, ratified sprint plan) — advances SCRUM-2481
-- (server-side evidence-level trust, open P0).
--
-- PROBLEM: src/lib/csvParser.ts extractAnchorRecordsAsync() synthesizes a
-- "fingerprint" by hashing the CSV ROW TEXT (buildRowCanonical + sha256Hex)
-- whenever the bulk-import CSV has no mapped `fingerprint` column. That value
-- lands in the SAME `anchors.fingerprint` column as a real document hash
-- computed client-side from actual file bytes (Constitution 1.6). Downstream
-- (public verify page, /api/v1 responses, proof packages) the two are
-- indistinguishable — a §1.5 honesty violation: "we fingerprinted a
-- document" and "an issuer asserted a record" are different claims and must
-- be provable as different claims, not just described differently in copy.
--
-- RULING: row-mode is NOT blocked or removed (it is the intended
-- credential-issuance path — an issuing organization asserting record
-- content it stands behind). It is separated into a distinct, LOAD-BEARING
-- evidence class at the DATA layer.
--
-- WHY A NEW COLUMN, NOT THE EXISTING `verification_level` /
-- `proof_completeness_class` MACHINERY: this migration rides the SAME
-- STRUCTURAL PATTERN those two established (0354 proof_completeness_class:
-- additive nullable + CHECK + NOT VALID/VALIDATE lock discipline on a
-- multi-million-row table; 0355 get_public_anchor: explicit allow-list
-- projection, never a denylist pass-through; CSI-03 verification_level +
-- EvidenceLevelBadge/SourceProvenanceDisplay: measured/asserted/NOT-asserted
-- triad per §1.5). It is a NEW column rather than a new value smuggled into
-- either existing axis because both are semantically orthogonal:
--   - proof_completeness_class (anchor_proofs) classifies whether a SECURED
--     anchor's on-chain MERKLE PROOF is direct vs batch-reconstructable —
--     nothing to do with what was hashed to produce the fingerprint.
--   - verification_level (anchors.metadata, CSI-03/SCRUM-1599) classifies
--     HOW Arkova obtained an externally-SOURCED credential during credential
--     source import (Credly/Accredible/LinkedIn/URL-capture/AI-extraction).
--     It has no tier for "the customer typed structured data directly into
--     Arkova via CSV, no external source and no source document exist at
--     all" — forcing this into that enum would misrepresent an unrelated
--     claim (R-7 claims gate risk) rather than resolve the honesty gap.
-- A genuinely new axis, built with the same audited pattern, is the correct
-- "ride the machinery" reading: reuse the METHOD, not an unrelated ENUM.
--
-- SERVER-SIDE ENFORCEMENT (discharges SCRUM-2481 for THIS surface): fingerprint
-- computation is inherently client-side (Constitution 1.6), so the SERVER can
-- never independently verify "did the client really hash a real file's
-- bytes". What IS closed here: (1) the class vocabulary is a CHECK-constrained
-- 2-value enum, never arbitrary free text smuggled through the opaque
-- `anchors.metadata` blob the way verification_level currently is (the
-- SCRUM-2481 P0 gap); (2) `bulk_create_anchors` (this file) computes the
-- class ITSELF from a narrow boolean signal (was a fingerprint CSV column
-- mapped) rather than trusting a client-supplied label string — the
-- structural fact of which code branch ran, not a spoofable claim about it.
--
-- BACKFILL POLICY (§1.5 — never assert what cannot be proven): existing
-- anchors are NOT backfilled. There is no reliable way to retroactively
-- determine whether a pre-this-migration anchor's fingerprint came from real
-- document bytes or synthesized row text. `fingerprint_source IS NULL` means
-- "unclassified — created before this distinction existed", displayed
-- honestly as such, never silently defaulted to either class.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.bulk_create_anchors(jsonb);
--   -- (recreate the pre-0375 body from 00000000000000_baseline_at_main_HEAD.sql
--   --  lines 1168-1263 if rollback must restore prior behavior exactly)
--   CREATE OR REPLACE FUNCTION public.get_public_anchor(p_public_id text) ...
--   -- (restore the pre-0375 body from 0355_scrum2485_public_anchor_base_projection_allowlist.sql)
--   ALTER TABLE public.anchors
--     DROP CONSTRAINT IF EXISTS anchors_fingerprint_source_check;
--   ALTER TABLE public.anchors
--     DROP COLUMN IF EXISTS fingerprint_source;
--   NOTIFY pgrst, 'reload schema';

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. fingerprint_source column (additive, nullable) + CHECK.
--    Lock discipline mirrors 0354: NOT VALID (brief ACCESS EXCLUSIVE catalog
--    touch, no scan) then a separate VALIDATE CONSTRAINT (SHARE UPDATE
--    EXCLUSIVE, does not block reads/writes) — required on the ~2.97M-row
--    prod anchors table.
-- ---------------------------------------------------------------------------
ALTER TABLE public.anchors
  ADD COLUMN IF NOT EXISTS fingerprint_source text;

ALTER TABLE public.anchors
  DROP CONSTRAINT IF EXISTS anchors_fingerprint_source_check;

ALTER TABLE public.anchors
  ADD CONSTRAINT anchors_fingerprint_source_check CHECK (
    fingerprint_source IS NULL
    OR fingerprint_source IN (
      'document_bytes',
      'issuer_record_attestation'
    )
  ) NOT VALID;

ALTER TABLE public.anchors
  VALIDATE CONSTRAINT anchors_fingerprint_source_check;

COMMENT ON COLUMN public.anchors.fingerprint_source IS
  'R19 (CTO ruling 2026-07-28): evidence class for how `fingerprint` was computed. NULL = unclassified (anchor predates this column; NEVER backfilled/guessed, per Constitution 1.5). document_bytes = a real file''s bytes were fingerprinted client-side (Constitution 1.6) — includes both direct document upload AND a CSV bulk-import row that supplied a pre-computed fingerprint column. issuer_record_attestation = no source document was supplied; the fingerprint commits the issuer''s asserted CSV row content only (src/lib/csvParser.ts buildRowCanonical). This is NOT proof_completeness_class (anchor_proofs; classifies on-chain Merkle-proof shape) and NOT verification_level (anchors.metadata; classifies external credential-source-import authentication) — an orthogonal, additive axis. Public verify page + /api/v1 must render the two classes distinctly and never imply document custody for issuer_record_attestation (R-7 claims gate).';

-- ---------------------------------------------------------------------------
-- 2. bulk_create_anchors: server computes fingerprint_source from a narrow
--    boolean signal (`fingerprintProvided`) instead of trusting an arbitrary
--    client-supplied label. Body otherwise IDENTICAL to the baseline
--    definition (00000000000000_baseline_at_main_HEAD.sql:1168-1263) — only
--    the new anchor_fingerprint_source local + its two references are added.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."bulk_create_anchors"("anchors_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    SET "statement_timeout" TO '60s'
    AS $$
DECLARE
  caller_profile RECORD;
  anchor_record jsonb;
  created_count integer := 0;
  skipped_count integer := 0;
  failed_count integer := 0;
  results jsonb := '[]'::jsonb;
  new_anchor_id uuid;
  existing_anchor_id uuid;
  anchor_fingerprint text;
  anchor_filename text;
  anchor_file_size integer;
  anchor_credential_type credential_type;
  anchor_metadata jsonb;
  anchor_fingerprint_source text;
  quota_remaining integer;
  batch_size integer;
  lock_key bigint;
BEGIN
  SELECT * INTO caller_profile FROM profiles WHERE id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0001'; END IF;

  lock_key := ('x' || left(md5(auth.uid()::text), 15))::bit(64)::bigint;
  PERFORM pg_advisory_xact_lock(lock_key);

  quota_remaining := check_anchor_quota();
  batch_size := jsonb_array_length(anchors_data);

  IF quota_remaining IS NOT NULL AND batch_size > quota_remaining THEN
    RAISE EXCEPTION 'Quota exceeded: % records remaining but % requested', quota_remaining, batch_size USING ERRCODE = 'P0002';
  END IF;

  FOR anchor_record IN SELECT * FROM jsonb_array_elements(anchors_data)
  LOOP
    anchor_fingerprint := lower(anchor_record->>'fingerprint');
    anchor_filename := anchor_record->>'filename';
    anchor_file_size := (anchor_record->>'fileSize')::integer;

    BEGIN
      IF anchor_record->>'credentialType' IS NOT NULL AND anchor_record->>'credentialType' != '' THEN
        anchor_credential_type := (anchor_record->>'credentialType')::credential_type;
      ELSE
        anchor_credential_type := NULL;
      END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      anchor_credential_type := NULL;
    END;

    IF anchor_record->'metadata' IS NOT NULL AND jsonb_typeof(anchor_record->'metadata') = 'object' THEN
      anchor_metadata := anchor_record->'metadata';
    ELSE
      anchor_metadata := NULL;
    END IF;

    -- R19: server-computed, not client-labeled. `fingerprintProvided` is a
    -- narrow boolean (was a fingerprint CSV column mapped for this row) set
    -- by the SAME client code that decides whether to hash row text
    -- (src/lib/csvParser.ts) — the structural fact of which branch ran, not
    -- an arbitrary free-text evidence claim. Missing/non-boolean input
    -- fails closed to NULL (unclassified), never guessed toward either
    -- class.
    IF jsonb_typeof(anchor_record->'fingerprintProvided') = 'boolean' THEN
      IF (anchor_record->>'fingerprintProvided')::boolean THEN
        anchor_fingerprint_source := 'document_bytes';
      ELSE
        anchor_fingerprint_source := 'issuer_record_attestation';
      END IF;
    ELSE
      anchor_fingerprint_source := NULL;
    END IF;

    SELECT id INTO existing_anchor_id FROM anchors WHERE fingerprint = anchor_fingerprint AND user_id = auth.uid() AND deleted_at IS NULL;

    IF existing_anchor_id IS NOT NULL THEN
      skipped_count := skipped_count + 1;
      results := results || jsonb_build_object('fingerprint', anchor_fingerprint, 'status', 'skipped', 'reason', 'duplicate', 'existingId', existing_anchor_id);
    ELSE
      IF quota_remaining IS NOT NULL AND created_count >= quota_remaining THEN
        failed_count := failed_count + 1;
        results := results || jsonb_build_object('fingerprint', anchor_fingerprint, 'status', 'failed', 'reason', 'quota_exceeded');
        CONTINUE;
      END IF;

      BEGIN
        INSERT INTO anchors (user_id, org_id, fingerprint, filename, file_size, credential_type, metadata, fingerprint_source, status)
        VALUES (auth.uid(), caller_profile.org_id, anchor_fingerprint, anchor_filename, anchor_file_size, anchor_credential_type, anchor_metadata, anchor_fingerprint_source, 'PENDING')
        RETURNING id INTO new_anchor_id;

        created_count := created_count + 1;
        results := results || jsonb_build_object('fingerprint', anchor_fingerprint, 'status', 'created', 'id', new_anchor_id);
      EXCEPTION WHEN OTHERS THEN
        failed_count := failed_count + 1;
        results := results || jsonb_build_object('fingerprint', anchor_fingerprint, 'status', 'failed', 'reason', 'insert_failed');
      END;
    END IF;
  END LOOP;

  -- Audit event — actor_id only, NO actor_email (column dropped in 0170)
  INSERT INTO audit_events (event_type, event_category, actor_id, org_id, target_type, target_id, details)
  VALUES ('BULK_VERIFICATION_RUN', 'ANCHOR', auth.uid(), caller_profile.org_id, 'batch',
    'bulk_create_' || to_char(now(), 'YYYYMMDD_HH24MISS'),
    jsonb_build_object('total', jsonb_array_length(anchors_data), 'created', created_count, 'skipped', skipped_count, 'failed', failed_count)::text);

  RETURN jsonb_build_object('total', jsonb_array_length(anchors_data), 'created', created_count, 'skipped', skipped_count, 'failed', failed_count, 'results', results);
END;
$$;

ALTER FUNCTION "public"."bulk_create_anchors"("anchors_data" "jsonb") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."bulk_create_anchors"("anchors_data" "jsonb") IS 'Creates multiple anchors in a batch. Idempotent - skips duplicates based on fingerprint. R19: computes fingerprint_source server-side from the boolean fingerprintProvided signal (never a client-supplied label).';

-- ---------------------------------------------------------------------------
-- 3. get_public_anchor: add `fingerprint_source` as a new TOP-LEVEL
--    additive-nullable key (mirrors the existing `fingerprint` / `filename` /
--    `file_size` top-level projection — it is a real anchors column, not a
--    metadata sub-key). Body otherwise IDENTICAL to 0355's definition.
-- ---------------------------------------------------------------------------
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
      -- R19: additive-nullable top-level key (§1.8). NULL for anchors
      -- predating this migration ("unclassified" — see column COMMENT).
      'fingerprint_source', a.fingerprint_source,
      'filename', a.filename,
      'file_size', a.file_size,
      'issuer_public_id', o.public_id,
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
  IS 'Public anchor projection for anon callers. R19: adds additive-nullable top-level fingerprint_source key. SCRUM-2485: base metadata '
     'sub-object is an EXPLICIT jsonb_build_object allow-list (not the '
     'sanitize_metadata_for_public denylist pass-through) so a new anchors.metadata '
     'key cannot auto-project. SECURITY DEFINER, search_path=public, status filter, '
     'deleted_at guard preserved.';

COMMIT;
