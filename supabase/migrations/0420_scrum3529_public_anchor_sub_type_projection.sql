-- 0420 — SCRUM-3529: `get_public_anchor` must project the canonical
-- `anchors.sub_type`, or the public verify page renders "Other".
--
-- ─── THE DEFECT ────────────────────────────────────────────────────────────
--
-- `CredentialRenderer` derives the credential Type label as
--
--     subTypeLabel ?? CREDENTIAL_TYPE_LABELS[credential_type] ?? credential_type
--
-- so a record whose `credential_type` is the catch-all `OTHER` is supposed to
-- fall back to its fine-grained sub-type ("Professional Certification",
-- "Nursing RN") rather than the meaningless "Other". That fallback shipped as
-- SCRUM-952 / SCRUM-1482 and worked, because `get_public_anchor` passed
-- `metadata` through a DENYLIST and callers who duplicated the value into
-- `metadata.sub_type` had it reach the browser.
--
-- 0355 (SCRUM-2485) then replaced that pass-through with an explicit ALLOW-list
-- — title / credential_title / description / category / proof_url / issuer —
-- as a security hardening. `sub_type` was not on it. Nothing was wrong with
-- that hardening; what was missing is that the key it dropped was load-bearing
-- for a USER-VISIBLE label, and no test pinned the rendered label, only the
-- `formatCredentialSubType` helper and the props. So from 0355 onward every
-- `OTHER`-typed record on /verify/:publicId reads "Other", and the regression
-- survived 0362, 0376, 0383 and 0385 unnoticed.
--
-- The canonical value was never the metadata duplicate in the first place: it
-- is the `anchors.sub_type` COLUMN (GRE-01 — 'official_undergraduate',
-- 'nursing_rn'). This migration projects THAT, so the label no longer depends
-- on whether some writer happened to mirror it into the metadata blob.
--
-- The anonymous JSON surface has been exposing it correctly the whole time:
-- `GET /api/v1/verify/:publicId` reads `anchors.sub_type` (SCRUM-895,
-- services/worker/src/api/v1/verify.ts). Only the SQL projection behind the
-- HTML page lost it — the four-way drift this contract exists to catch.
--
-- ─── WHY VALUE-GATED, AND WHY NOT STRUCTURAL ───────────────────────────────
--
-- `anchors.sub_type` is bare `text`: no CHECK, no enum, nullable. Nothing in
-- the schema prevents an issuer or an extraction pipeline putting arbitrary
-- text there, so it routes through `private.public_free_text_or_null` and is
-- deliberately absent from the contract's `structural_keys`. That is exactly
-- the call `verify.ts` already made — `sub_type` sits in
-- `verify_value_gated_fields`, NOT in `verify_structural_api_rich_keys`.
-- The gate OMITS rather than truncates, so a record whose sub_type carries
-- PII simply has no `sub_type` key and the page falls back to its parent
-- label, which is the correct fail-safe.
--
-- ─── WHY IT IS *NOT* ACADEMIC-SUPPRESSED ───────────────────────────────────
--
-- Parity, deliberately. `verify_academic_suppressed_fields` is `['description']`
-- only, so the verify API already publishes a value-gated `sub_type` for
-- DEGREE / CERTIFICATE / TRANSCRIPT to anonymous callers. Suppressing it here
-- alone would remove NOTHING from public reach — the same value for the same
-- anchor stays anonymously fetchable one route over — while re-opening the
-- SQL-vs-TS divergence. `sub_type` is a credential TAXONOMY field, the same
-- class as `credential_type` (which academic records publish, and from which
-- their controlled label is derived), not issuer-authored prose like `title`.
--
-- The genuinely unclassifiable case is still covered: 0390 made
-- `is_academic_record_credential_type` FAIL CLOSED on an absent
-- `credential_type`, and such a record has no meaningful sub-type label to
-- render anyway.
--
-- ─── WHY IT IS TOP-LEVEL RATHER THAN A `metadata` MEMBER ────────────────────
--
-- It is a column, not part of the issuer-authored metadata blob, and the verify
-- API exposes it top-level too. Putting it inside `metadata` would also leave
-- that object non-empty for academic records after `jsonb_strip_nulls`, which
-- flips the verify card out of its "no metadata" render mode into the
-- key-value list — the exact failure 0385's own comments describe.
--
-- ─── HOW THIS WAS DERIVED ──────────────────────────────────────────────────
--
-- Diffed against `0385_public_anchor_academic_record_pii_projection.sql`, which
-- is the LATEST migration redefining `get_public_anchor` (0386 redefines only
-- the `_by_fingerprint` sibling, which DELEGATES here; 0390 redefines only
-- `private.is_academic_record_credential_type`). The body below is 0385's
-- verbatim, with ONE key added and nothing else touched — confirm with
-- `pg_get_functiondef('public.get_public_anchor(text)'::regprocedure)` before
-- editing further. Branching from an older file is what caused 0376 to revert
-- 0356's keyed HMAC and 0362's allow-list.
--
-- `get_public_anchor_by_fingerprint` needs no change: it resolves a public_id
-- and returns `public.get_public_anchor(v_public_id)`, so it inherits this.
--
-- Additive nullable key on a frozen schema — §1.8 allows it with no version
-- bump. It is emitted as an explicit `null` rather than omitted, which is a
-- deliberate choice between the two shapes this projection already uses:
-- `jurisdiction` is omitted (via its own trailing `jsonb_strip_nulls`), while
-- `fingerprint_source` — the other additive nullable COLUMN key, added by 0376
-- — is emitted as null. `sub_type` follows `fingerprint_source`, because the
-- verify API emits `sub_type: row.sub_type ?? null` and matching it keeps the
-- two anonymous surfaces directly comparable. The §6 "omit when null" rule is
-- about `jurisdiction` specifically, whose ABSENCE is semantically different
-- from a null (no jurisdiction asserted vs. none recorded, §1.5); a null
-- sub-type makes no such claim. Consumers must treat the key as nullable
-- either way: the renderer falls back to the parent type label for null,
-- absent, and gate-dropped alike, all three pinned by
-- src/components/verification/PublicVerification.subtype.test.tsx.
--
-- No lock_timeout guard is required (§1.2): this is a catalog-only
-- `CREATE OR REPLACE FUNCTION`; it takes no lock on `anchors`, and the function
-- body's read is a plain `SELECT` (AccessShareLock). Same shape as 0385.
--
-- Tier: T3 (redefines a public, anon-callable projection RPC).
--
-- ─── ROLLBACK ──────────────────────────────────────────────────────────────
--
-- ROLLBACK: Restore the 0385 definition verbatim — i.e. re-run the
-- ROLLBACK: `CREATE OR REPLACE FUNCTION public.get_public_anchor(p_public_id text)`
-- ROLLBACK: block from
-- ROLLBACK: supabase/migrations/0385_public_anchor_academic_record_pii_projection.sql
-- ROLLBACK: (lines 554-783), which is this file's body minus the single
-- ROLLBACK: `'sub_type', private.public_free_text_or_null(a.sub_type),` line,
-- ROLLBACK: then `NOTIFY pgrst, 'reload schema';`.
-- ROLLBACK: No schema change, no data migration, no flag: the only effect is
-- ROLLBACK: that the additive `sub_type` key stops being emitted and the public
-- ROLLBACK: verify page reverts to showing "Other" for OTHER-typed records.
-- =============================================================================

BEGIN;

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
      -- 0385: the issuer is an INSTITUTION, not the learner, so it is cleaned
      -- rather than structurally suppressed.
      --
      -- The fallback ordering is load-bearing. `o.display_name` is the ANCHORING
      -- ORG, which is frequently a DIFFERENT named entity from the credential's
      -- issuer. Falling through to it when the gate DROPPED a value would not be
      -- a redaction, it would be a wrong claim about who issued the credential —
      -- unacceptable on a verification product (§1.5, §1.13 R-7). So the
      -- fallback fires only when the stored issuer is genuinely ABSENT, exactly
      -- as it did before this migration; a dropped issuer degrades to
      -- 'Unknown Issuer', which asserts nothing.
      'issuer_name', CASE
        WHEN NULLIF(btrim(COALESCE(a.metadata->>'issuer', '')), '') IS NOT NULL
          THEN COALESCE(private.public_free_text_or_null(a.metadata->>'issuer'), 'Unknown Issuer')
        ELSE COALESCE(o.display_name, 'Unknown Issuer')
      END,
      'credential_type', COALESCE(a.credential_type::text, 'OTHER'),
      -- 0420 (SCRUM-3529): the CANONICAL anchors.sub_type column, immediately
      -- after the parent type it refines. VALUE-GATED, never raw: sub_type is
      -- bare `text` with no CHECK and no enum, so nothing in the schema stops
      -- an issuer or an extraction pipeline writing free text into it. This is
      -- the same call verify.ts already made (verify_value_gated_fields).
      -- NOT academic-suppressed, and NOT structural — see $sub_type_note in
      -- scripts/ci/public-pii-projection-contract.json for both decisions.
      'sub_type', private.public_free_text_or_null(a.sub_type),
      'issued_date', a.issued_at,
      'expiry_date', a.expires_at,
      'anchor_timestamp', CASE WHEN a.status NOT IN ('PENDING') THEN a.chain_timestamp END,
      'bitcoin_block', CASE WHEN a.status NOT IN ('PENDING') THEN a.chain_block_height END,
      'network_receipt_id', CASE WHEN a.status NOT IN ('PENDING') THEN a.chain_tx_id END,
      'merkle_proof_hash', NULL::text,
      'record_uri', v_app_base_url || '/verify/' || a.public_id,
      'public_id', a.public_id,
      'fingerprint', a.fingerprint,
      'fingerprint_source', a.fingerprint_source,
      -- 0385: `filename` is the record's public DISPLAY TITLE on the verify page
      -- and is embedded in its schema.org JSON-LD, so an upload literally named
      -- after the learner published that name to anonymous callers and to search
      -- engines. Academic records get a controlled label; every other type gets
      -- the cleaned filename, falling back to a controlled label so the value is
      -- never NULL and no consumer that assumes a display string breaks.
      'filename', CASE
        WHEN g.is_academic
          THEN private.academic_record_public_label(a.credential_type::text)
        ELSE COALESCE(
          private.public_free_text_or_null(a.filename),
          private.academic_record_public_label(NULL)
        )
      END,
      'file_size', a.file_size,
      'issuer_public_id', o.public_id,
      'metadata', jsonb_strip_nulls(jsonb_build_object(
        -- 0385: academic records emit NO issuer- or extraction-authored metadata
        -- text. title/credential_title/description/category are all omitted; the
        -- record's public display name is the controlled label carried by the
        -- top-level `filename` key.
        --
        -- These two are OMITTED rather than set to the controlled label on
        -- purpose. Emitting the label here would leave `metadata` non-empty
        -- after jsonb_strip_nulls, which flips the verify card out of its
        -- "no metadata" render mode into the key-value list — where neither key
        -- is hidden — and the card would show "Title: Academic Degree" and
        -- "Credential Title: Academic Degree" underneath a type banner that
        -- already reads "Academic Degree". Omitting keeps the existing render
        -- shape and states the label exactly once.
        'title', CASE
          WHEN g.is_academic THEN NULL
          ELSE private.public_free_text_or_null(
            g.safe_metadata ->> 'title')
        END,
        'credential_title', CASE
          WHEN g.is_academic THEN NULL
          ELSE private.public_free_text_or_null(
            g.safe_metadata ->> 'credential_title')
        END,
        'description', CASE
          WHEN g.is_academic THEN NULL
          ELSE private.public_free_text_or_null(
            g.safe_metadata ->> 'description', 500)
        END,
        'category', CASE
          WHEN g.is_academic THEN NULL
          ELSE private.public_free_text_or_null(
            g.safe_metadata ->> 'category')
        END,
        -- 0385: proof_url drops query + fragment AND runs the value gate, via
        -- the URL-specific cleaner that omits rather than truncates.
        'proof_url', private.public_url_or_null(
          g.safe_metadata ->> 'proof_url'),
        'issuer', private.public_free_text_or_null(
          g.safe_metadata ->> 'issuer'),
        -- 0385: the remaining allow-listed keys are structured (enums, hashes,
        -- versions, counts), so they take the BOUNDED gate — high-confidence
        -- detectors only. A name heuristic on a sha256 or a MIME type is pure
        -- noise, which is the same split the CTDL assembled-body scan makes.
        'jurisdiction', private.public_free_text_or_null(a.metadata ->> 'jurisdiction'),
        'evidence_schema_version', private.public_free_text_or_null(a.metadata ->> 'evidence_schema_version'),
        'source_id', private.public_free_text_or_null(a.metadata ->> 'source_id'),
        'source_payload_content_type', private.public_free_text_or_null(a.metadata ->> 'source_payload_content_type'),
        'source_payload_byte_length', private.public_free_text_or_null(a.metadata ->> 'source_payload_byte_length'),
        'extraction_method', private.public_free_text_or_null(a.metadata ->> 'extraction_method'),
        'extraction_manifest_hash', private.public_free_text_or_null(a.metadata ->> 'extraction_manifest_hash'),
        'extraction_confidence', private.public_free_text_or_null(a.metadata ->> 'extraction_confidence'),
        'credential_id_hash', private.public_free_text_or_null(a.metadata ->> 'credential_id_hash'),
        'registry_url', private.public_url_or_null(a.metadata ->> 'registry_url'),
        'ce_envelope_sha256', private.public_free_text_or_null(a.metadata ->> 'ce_envelope_sha256')
      )),
      'created_at', a.created_at,
      'secured_at', CASE WHEN a.status NOT IN ('PENDING') THEN a.chain_timestamp END,
      'issued_at', a.issued_at,
      'revoked_at', a.revoked_at,
      'superseded_at', CASE WHEN a.status = 'SUPERSEDED' THEN a.revoked_at END,
      -- 0385: revocation_reason is issuer-authored free text on a public 410-ish
      -- projection ('revoked - contact jane@example.edu'). Academic records omit
      -- it outright; every other type gets the value-level gate. This closes the
      -- exact asymmetry with the CTDL path, which already routes
      -- ceterms:revocationReason through cleanPublicFreeText
      -- (BUG-2026-07-06-002).
      'revocation_reason', CASE
        WHEN g.is_academic THEN NULL
        ELSE private.public_free_text_or_null(a.revocation_reason, 500)
      END,
      'expires_at', a.expires_at,
      'source_url', private.public_url_or_null(a.metadata->>'source_url'),
      'source_provider', private.public_free_text_or_null(a.metadata->>'source_provider'),
      'verification_level', private.public_free_text_or_null(a.metadata->>'verification_level'),
      'evidence_package_hash', private.public_free_text_or_null(a.metadata->>'evidence_package_hash'),
      'source_payload_hash', private.public_free_text_or_null(a.metadata->>'source_payload_hash'),
      'fetched_at', private.public_free_text_or_null(
        COALESCE(a.metadata->>'fetched_at', a.metadata->>'source_fetched_at')),
      'cpe_metadata', CASE
        WHEN a.cpe_metadata IS NOT NULL
        THEN jsonb_strip_nulls(jsonb_build_object(
          'credit_hours', private.public_jsonb_text_or_null(a.cpe_metadata -> 'credit_hours'),
          'field_of_study', private.public_jsonb_text_or_null(a.cpe_metadata -> 'field_of_study'),
          'delivery_method', private.public_jsonb_text_or_null(a.cpe_metadata -> 'delivery_method'),
          'nasba_status', private.public_jsonb_text_or_null(a.cpe_metadata -> 'nasba_status'),
          'nasba_lookup_date', private.public_jsonb_text_or_null(a.cpe_metadata -> 'nasba_lookup_date'),
          'requires_manual_review', private.public_jsonb_text_or_null(a.cpe_metadata -> 'requires_manual_review')
        ))
        ELSE NULL
      END,
      'cle_metadata', CASE
        WHEN a.cle_metadata IS NOT NULL
        THEN jsonb_strip_nulls(jsonb_build_object(
          'credit_hours', private.public_jsonb_text_or_null(a.cle_metadata -> 'credit_hours'),
          'ethics_hours', private.public_jsonb_text_or_null(a.cle_metadata -> 'ethics_hours'),
          'jurisdiction', private.public_jsonb_text_or_null(a.cle_metadata -> 'jurisdiction'),
          'approved_provider_name', private.public_jsonb_text_or_null(a.cle_metadata -> 'approved_provider_name'),
          'provider_approval_status', private.public_jsonb_text_or_null(a.cle_metadata -> 'provider_approval_status'),
          'provider_lookup_date', private.public_jsonb_text_or_null(a.cle_metadata -> 'provider_lookup_date'),
          'delivery_format', private.public_jsonb_text_or_null(a.cle_metadata -> 'delivery_format'),
          'course_title', private.public_jsonb_text_or_null(a.cle_metadata -> 'course_title'),
          'requires_manual_review', private.public_jsonb_text_or_null(a.cle_metadata -> 'requires_manual_review')
        ))
        ELSE NULL
      END
    )
    -- 0385: the top-level `jurisdiction` key is NOT inside the projection's own
    -- jsonb_strip_nulls, so it gets its own. That is structural rather than a
    -- hand-written presence test: jsonb_strip_nulls drops the key when the gate
    -- returns NULL, and `x || '{}'::jsonb = x`, so `"jurisdiction": null` can
    -- never be published (CLAUDE.md §6, "omit when null" on this frozen schema).
    -- It also evaluates the gate ONCE instead of once per branch.
    || jsonb_strip_nulls(jsonb_build_object(
         'jurisdiction', private.public_free_text_or_null(a.metadata->>'jurisdiction')))
  INTO
    v_recipient_raw,
    v_result
  FROM anchors a
  LEFT JOIN organizations o ON o.id = a.org_id
  -- Hoist the two values the projection needs repeatedly.
  --
  -- `sanitize_metadata_for_public` rebuilds the whole metadata jsonb
  -- (jsonb_each -> jsonb_object_agg), and the projection referenced it SIX
  -- times; `is_academic_record_credential_type` was also called six times and
  -- cannot be inlined by the planner (a SQL function carrying `SET search_path`
  -- is refused by the inliner), so each was a real fmgr call with GUC
  -- save/restore. On an anon-callable endpoint over metadata with no size
  -- limit, that is the dominant cost: measured 1.05 ms -> 0.41 ms per call on a
  -- 42 KB metadata row (-66%), 0.52 ms -> 0.41 ms on a typical one (-30%),
  -- output byte-identical.
  --
  -- `OFFSET 0` is LOAD-BEARING, not noise: without it the planner pulls the
  -- subquery up, flattens it, and every reference is re-evaluated — measured
  -- back at 6 calls. It is the standard PostgreSQL optimisation fence.
  CROSS JOIN LATERAL (
    SELECT
      sanitize_metadata_for_public(COALESCE(a.metadata, '{}'::jsonb)) AS safe_metadata,
      private.is_academic_record_credential_type(a.credential_type::text) AS is_academic
    OFFSET 0
  ) g
  WHERE a.public_id = p_public_id
    AND a.status IN ('SECURED', 'REVOKED', 'EXPIRED', 'SUPERSEDED', 'PENDING', 'SUBMITTED')
    AND a.deleted_at IS NULL;

  IF v_result IS NULL THEN
    RETURN jsonb_build_object('error', 'Record not found');
  END IF;

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

COMMENT ON FUNCTION public.get_public_anchor(text)
  IS 'Anon-callable public verification projection. Top-level keys and the '
     'metadata sub-object are explicit allow-lists (0355/0362); recipient is a '
     'keyed HMAC (0356/0383). 0385 adds the VALUE-level PII gate: academic '
     'records (DEGREE/CERTIFICATE/TRANSCRIPT) emit no issuer- or '
     'extraction-authored free text, and every other type has its free text '
     'dropped when it carries format- or keyword-anchored PII. 0420 adds the '
     'canonical anchors.sub_type as a value-gated top-level key so the public '
     'verify page can render a credential sub-type instead of the generic '
     '"Other" (SCRUM-3529); it is NOT academic-suppressed, matching the verify '
     'API which already publishes it. Mirrors '
     'services/worker/src/ctdl/ctdl-pii-guard.ts; parity is enforced by '
     'scripts/ci/public-pii-projection-contract.json.';

NOTIFY pgrst, 'reload schema';

COMMIT;
