BEGIN;
SET LOCAL lock_timeout = '5s';

-- =============================================================================
-- 0415 — FD-FERPA-1: honour `anchors.directory_info_opt_out` on the public
--        projections. The column has existed since archive migration
--        `0197_reg02_directory_info_opt_out.sql` and NO SQL projection has ever
--        read it.
--
-- ── THE DEFECT ─────────────────────────────────────────────────────────────
--
-- The 0197 column comment states the obligation exactly:
--
--     FERPA Section 99.37 — when true, directory-level fields (name, degree
--     type, dates) are suppressed in verification API responses
--
-- The column shipped, the API that writes it shipped
-- (`services/worker/src/api/v1/directory-opt-out.ts`), three production records
-- carry it — and the suppression was wired to nothing on the SQL side. The
-- control existed, was represented as implemented, and enforced nothing. Same
-- shape as FD-GATE-1 filed the same week: a control believed to be global,
-- live on one surface out of several.
--
-- ── WHAT IS ACTUALLY LEAKING, MEASURED ─────────────────────────────────────
--
-- Read-only against prod `vzwyaatejekddvltxyye` on 2026-08-21, by CALLING the
-- function rather than reasoning about its source:
--
--   SELECT public_id, credential_type FROM anchors WHERE directory_info_opt_out;
--     -> ARK-DOC-6Y9RK6 | NULL
--        ARK-DOC-JTYBP3 | NULL
--        ARK-DOC-QAUVZY | NULL      (3 rows, all status = SECURED)
--
--   SELECT public.get_public_anchor('ARK-DOC-6Y9RK6');
--     -> { "issuer_name": "Arkova",
--          "issuer_public_id": "uncwm6y22wfz",
--          "cpe_metadata": { "credit_hours": 8,
--                            "field_of_study": "Taxation",
--                            "requires_manual_review": false },
--          "filename": "Secured Document", "metadata": {}, ... }
--
-- Two corrections to the finding document, both load-bearing:
--
--   1. THE LIVE LEAK IS `cpe_metadata` AND `issuer_name`, NOT "name, degree
--      type, dates". `field_of_study` is verbatim 34 CFR 99.3 directory
--      information ("major field of study"); the other two records carry
--      "Auditing" and "Ethics". The name/title fields are already suppressed
--      for these rows, but ONLY BY ACCIDENT: 0390 made
--      `private.is_academic_record_credential_type(NULL)` return TRUE, so a
--      NULL-typed record takes 0385's academic branch. That is a free-text rule
--      that happens to cover them, not the opt-out being honoured, and it
--      covers nothing for an opted-out record that HAS a type.
--
--   2. THE REST PATH DOES NOT PROTECT THESE ROWS EITHER. The finding says the
--      REST path "does consult the flag", and it does — but
--      `buildVerificationResult` computes
--          anchor.credential_type && FERPA_EDUCATION_TYPES.includes(...)
--      which is FALSY for a NULL type, so `suppressDirectory` is false for all
--      three records. Consulting a flag and honouring it are different things.
--      Fixed in the same PR (`suppressesDirectoryInfo` in ferpa.ts), so both
--      anonymous surfaces answer with one rule.
--
-- ── WHY THE PREDICATE FAILS CLOSED ─────────────────────────────────────────
--
-- Because of (1) above: a predicate written as `type IN (education types)`
-- evaluates FALSE for every record this finding is about, and this migration
-- would have shipped, gone green, and changed nothing in production. An absent
-- type cannot be shown to be outside FERPA's reach, so it suppresses. This is
-- the identical inversion 0390 applied to the academic free-text gate:
-- recognising SAFETY by enumeration means the unclassifiable must fail closed.
--
-- ── WHAT IS SUPPRESSED, AND WHAT MUST KEEP WORKING ─────────────────────────
--
-- SUPPRESSED (directory information, 34 CFR 99.3):
--   issuer_name -> 'Unknown Issuer'      issuer_public_id -> NULL
--   filename    -> 'Secured Document'    issued_date / issued_at -> NULL
--   cpe_metadata -> NULL                 expiry_date / expires_at -> NULL
--   cle_metadata -> NULL                 revocation_reason -> NULL
--   metadata.{title,credential_title,description,category,issuer} -> omitted
--   recipient_identifier -> KEY OMITTED
--   + directory_info_suppressed: true    (additive, absent unless it fired)
--
-- UNTOUCHED, and this half is the point: the record still VERIFIES.
--   verified, status, public_id, fingerprint, fingerprint_source, record_uri,
--   anchor_timestamp, bitcoin_block, network_receipt_id, merkle_proof_hash,
--   created_at, secured_at, revoked_at, superseded_at, file_size.
--
-- Suppression drops FIELDS, never the record. The row filter is untouched, so
-- an opted-out anchor resolves exactly as before: turning it into
-- `{"error":"Record not found"}` would tell an anonymous verifier that a
-- genuinely anchored document does not exist — protecting nobody and breaking
-- the one answer the learner is relying on the record to give.
--
-- RECORDED RESIDUAL: `credential_type` is NOT suppressed. The 0197 comment
-- names "degree type", but `verify.test.ts` pins the REST path publishing it on
-- a suppressed record, and making the two anonymous surfaces disagree recreates
-- the asymmetry this fix exists to remove. It is pinned as a known residual in
-- `scripts/ci/public-pii-projection-contract.json`
-- ("directory_opt_out_residual_published_fields") so it is a decision on the
-- record rather than an omission for the next reader to rediscover. Changing it
-- means changing BOTH surfaces in one PR.
--
-- ── WHICH DEFINITIONS THIS IS BASED ON ─────────────────────────────────────
--
--   BASE for both functions: the LIVE PRODUCTION bodies as of 2026-08-21,
--   captured with
--       SELECT pg_get_functiondef(oid), md5(prosrc) FROM pg_proc
--        WHERE proname IN ('get_public_anchor','search_public_credentials');
--   on `vzwyaatejekddvltxyye`:
--       get_public_anchor(text)                 md5 83770caee7e7fe9c1fa3963dadb387c2
--       search_public_credentials(text,integer) md5 6c2d77e1af8aeb2a56d316443ad090a1
--   Both md5s are IDENTICAL to the repo files (0385 and 0387 respectively),
--   verified by rebuilding the whole migration set into a scratch database and
--   comparing `md5(prosrc)` — so the repo files were safe to diff against here.
--   Every line below except the named suppression branches is byte-for-byte the
--   current production body.
--
--   Doing this check is not ceremony: 0376 was branched from the stale 0355
--   file, silently reverted 0356's keyed recipient HMAC and 0362's allow-list,
--   and left a dictionary-reversible SHA-256 of recipient e-mail addresses on an
--   anon endpoint for four days.
--
--   NOTED IN PASSING, NOT FIXED HERE: `get_public_anchor_by_fingerprint` in
--   prod has md5 468db54e5a183703817c1b991986eb18 (1381 chars) while the repo
--   head (0386) is 1863 chars — prod is still running the PRE-0386 body, i.e.
--   the fingerprint existence oracle 0386 closed is still open in production.
--   0386 is merged but unapplied. That is an RTE prod-apply item, not this PR's.
--
-- ── WHY get_public_anchor_by_fingerprint IS NOT REDEFINED ───────────────────
--
-- It has no projection of its own. It resolves a `public_id` and returns
-- `public.get_public_anchor(v_public_id)` verbatim — "single source of redaction
-- truth", in 0386's own words — so it inherits this change completely.
-- Reproducing its body here to change nothing would be pure 0376 risk for zero
-- behavioural gain. The inheritance is a CLAIM, so it gets assertions rather
-- than a comment: `tests/rls/ferpa-directory-info-opt-out.test.ts` proves the
-- fingerprint path suppresses AND that its body is byte-identical to the
-- public-id path, and the contract suite fails if the delegation is ever forked.
--
-- ── WHY search_public_credentials EXCLUDES RATHER THAN BLANKS ───────────────
--
-- 0387's invariant, unchanged: you can only search for text we would be willing
-- to show you. Blanking the projected title while leaving the row MATCHABLE
-- converts a disclosure into a hit-count oracle — a caller confirms the record
-- exists from a non-empty result set without reading a single field. So the
-- opted-out row leaves the match set entirely.
--
-- Today this is belt-and-braces for the three live records (0387 already
-- excludes academic-and-untyped rows from matching) and load-bearing for CLE,
-- which is in the FERPA set but NOT in the academic set and is matchable now.
--
-- ── ENVELOPE ───────────────────────────────────────────────────────────────
--
--   SECURITY DEFINER + `SET search_path TO 'public'` preserved on both
--   functions (CLAUDE.md 1.4). No signature change and no DROP, so the ACL is
--   carried through unchanged: prod holds
--   `{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}`
--   on all three public functions and must still hold it after. These are
--   DELIBERATELY anon-callable (`scripts/ci/feedback-rules/secdef-function-grants.ts`
--   `DELIBERATELY_PUBLIC`) and 0364's suite pins that they stay so. The new
--   `private` helper is revoked from PUBLIC, anon and authenticated explicitly,
--   because on Supabase `ALTER DEFAULT PRIVILEGES` grants anon/authenticated
--   EXECUTE DIRECTLY at CREATE time and `REVOKE ... FROM PUBLIC` does not remove
--   a direct role grant (the 0364/0377/0378/0388/0406 defect class).
--
--   CLAUDE.md 1.8: no field is renamed, retyped or removed. `issued_date`,
--   `expiry_date`, `issued_at`, `expires_at`, `issuer_public_id`, `cpe_metadata`
--   and `cle_metadata` are already nullable on this projection and already null
--   on most records. `directory_info_suppressed` is additive and sits inside
--   `jsonb_strip_nulls`, so it is ABSENT unless suppression fired — no existing
--   consumer sees a new key on an existing record.
--
--   CLAUDE.md 1.3: no new user-visible string. 'Unknown Issuer' and
--   'Secured Document' are the controlled values this function already emits.
--
--   TIER: T3 (supabase/migrations/ + a security-sensitive anon-reachable
--   projection). Prod-apply is RTE/CTO-owned — NOT applied by this session.
--
-- ── ROLLBACK ───────────────────────────────────────────────────────────────
--
-- ROLLBACK: Re-apply the pre-0415 production bodies and drop the predicate.
-- ROLLBACK:   Restore `public.get_public_anchor(text)` from
-- ROLLBACK:   supabase/migrations/0385_public_anchor_academic_record_pii_projection.sql
-- ROLLBACK:   (prod md5 83770caee7e7fe9c1fa3963dadb387c2) and
-- ROLLBACK:   `public.search_public_credentials(text, integer)` from
-- ROLLBACK:   supabase/migrations/0387_public_search_learner_name_leak.sql
-- ROLLBACK:   (prod md5 6c2d77e1af8aeb2a56d316443ad090a1), then:
-- ROLLBACK:     DROP FUNCTION IF EXISTS private.is_directory_info_suppressed(boolean, text);
-- ROLLBACK:     NOTIFY pgrst, 'reload schema';
-- ROLLBACK: No schema change, no data migration, no flag. Reverting republishes
-- ROLLBACK: directory information for every learner who opted out.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The ONE suppression predicate. Every projection calls this; a second
-- hand-rolled copy is the drift the whole public-projection contract exists to
-- prevent. Lives in `private`, which is absent from supabase/config.toml's
-- exposed `schemas`, so PostgREST never introspects it and it can never become
-- a queryable oracle for the suppression rule (the 0388 defect class).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.is_directory_info_suppressed(
  p_opt_out boolean,
  p_credential_type text
)
  RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  SET search_path = private, public
AS $$
  SELECT CASE
    -- An unreadable flag is doubt, and doubt suppresses. `anchors.
    -- directory_info_opt_out` is NOT NULL DEFAULT false, so this branch is
    -- unreachable today; it is the direction the predicate must fail when that
    -- stops being true.
    WHEN p_opt_out IS NULL THEN true
    -- The opt-out is OPT-IN and defaults to false. Suppressing by default would
    -- blank every credential on the platform, which is not the obligation.
    WHEN NOT p_opt_out THEN false
    -- FAILS CLOSED on an absent type. All three production records carrying the
    -- flag have `credential_type IS NULL`; keyed on the education set alone,
    -- this predicate would suppress nothing for any of them.
    WHEN p_credential_type IS NULL OR btrim(p_credential_type) = '' THEN true
    -- The FERPA education set, identical to FERPA_EDUCATION_TYPES in
    -- services/worker/src/constants/ferpa.ts. It deliberately includes CLE and
    -- is NOT the academic free-text set (DEGREE/CERTIFICATE/TRANSCRIPT) that
    -- 0385/0390 use for a different job. Parity is pinned by
    -- src/tests/ferpa-directory-info-opt-out.contract.test.ts.
    ELSE upper(btrim(p_credential_type)) IN ('DEGREE', 'TRANSCRIPT', 'CERTIFICATE', 'CLE')
  END;
$$;

COMMENT ON FUNCTION private.is_directory_info_suppressed(boolean, text) IS
  'FD-FERPA-1 — SUPPRESSION predicate for the public anchor projections. TRUE '
  'means "this record must not publish directory information" (34 CFR 99.3: '
  'name, institution attended, major field of study, dates of attendance, '
  'degrees and awards received). Returns TRUE for an ABSENT credential type '
  '(NULL, empty, whitespace) and for a NULL flag, because a record that cannot '
  'be classified cannot be shown to be outside FERPA''s reach — all three '
  'production records carrying the opt-out have credential_type IS NULL, so a '
  'predicate keyed on the education set alone would suppress nothing for any of '
  'them. Returns FALSE when the flag is off (the opt-out is opt-in) and for a '
  'present non-education type (99.37 is an education-records right; the REST '
  'twin pins the same boundary). The REST twin is suppressesDirectoryInfo() in '
  'services/worker/src/constants/ferpa.ts.';

REVOKE ALL ON FUNCTION private.is_directory_info_suppressed(boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.is_directory_info_suppressed(boolean, text) TO service_role;

-- -----------------------------------------------------------------------------
-- get_public_anchor — the LIVE PROD (0385) BODY with the FERPA Section 99.37
-- directory-information layer added. Every line except the branches marked
-- `0415:` is byte-identical to what production runs today (md5
-- 83770caee7e7fe9c1fa3963dadb387c2).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_public_anchor(p_public_id text) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_result jsonb;
  v_recipient_hash text;
  v_recipient_raw text;
  -- 0415: read through COALESCE below. If the row does not resolve, the
  -- function returns 'Record not found' before this is used; if it does, the
  -- predicate is total. The COALESCE is what keeps a future refactor from
  -- turning an unset flag into "publish".
  v_suppress_directory boolean;
  v_app_base_url text := COALESCE(NULLIF(current_setting('app.base_url', true), ''), 'https://app.arkova.ai');
  v_recipient_pepper text := NULLIF(current_setting('app.recipient_pepper', true), '');
BEGIN
  SELECT
    a.metadata->>'recipient',
    g.suppress_directory,
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
        -- 0415: the issuing INSTITUTION is directory information under FERPA
        -- 34 CFR 99.3 ("the most recent educational agency or institution
        -- attended"). It degrades to the controlled fallback this function
        -- already uses for an absent issuer, never to NULL: the verify page
        -- renders this as a display string, and 'Unknown Issuer' asserts
        -- nothing about who issued the credential.
        WHEN g.suppress_directory THEN 'Unknown Issuer'
        WHEN NULLIF(btrim(COALESCE(a.metadata->>'issuer', '')), '') IS NOT NULL
          THEN COALESCE(private.public_free_text_or_null(a.metadata->>'issuer'), 'Unknown Issuer')
        ELSE COALESCE(o.display_name, 'Unknown Issuer')
      END,
      -- 0415 RECORDED RESIDUAL: credential_type is deliberately NOT suppressed.
      -- The 0197 column comment names "degree type", but the REST projection
      -- pins publishing it (verify.test.ts asserts credential_type === 'DEGREE'
      -- on a suppressed record), and one row answering two ways across two
      -- anonymous surfaces is the asymmetry this fix exists to remove. Pinned
      -- as a known residual in scripts/ci/public-pii-projection-contract.json;
      -- changing it is a decision taken on BOTH surfaces in one PR.
      'credential_type', COALESCE(a.credential_type::text, 'OTHER'),
      -- 0415: award and expiry dates are directory information (99.3, "dates of
      -- attendance", "degrees, honors and awards received"). Both keys are
      -- already nullable on this projection, so NULL is in-shape rather than a
      -- schema change (CLAUDE.md 1.8).
      'issued_date', CASE WHEN g.suppress_directory THEN NULL ELSE a.issued_at END,
      'expiry_date', CASE WHEN g.suppress_directory THEN NULL ELSE a.expires_at END,
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
        -- 0415: an opted-out record that is NOT academic -- CLE is in the FERPA
        -- set but not the academic one -- would otherwise publish its cleaned
        -- filename, which is the record's public display title and its
        -- schema.org `name`. Controlled label, never NULL: the same rule as the
        -- academic branch directly above.
        WHEN g.suppress_directory
          THEN private.academic_record_public_label(NULL)
        ELSE COALESCE(
          private.public_free_text_or_null(a.filename),
          private.academic_record_public_label(NULL)
        )
      END,
      'file_size', a.file_size,
      -- 0415: the issuer's public id identifies the same institution as
      -- issuer_name. Suppressing the name while publishing a stable handle to
      -- it would be theatre. Already nullable -- a record with no org emits
      -- NULL here today.
      'issuer_public_id', CASE WHEN g.suppress_directory THEN NULL ELSE o.public_id END,
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
          WHEN g.suppress_directory THEN NULL
          ELSE private.public_free_text_or_null(
            g.safe_metadata ->> 'title')
        END,
        'credential_title', CASE
          WHEN g.is_academic THEN NULL
          WHEN g.suppress_directory THEN NULL
          ELSE private.public_free_text_or_null(
            g.safe_metadata ->> 'credential_title')
        END,
        'description', CASE
          WHEN g.is_academic THEN NULL
          WHEN g.suppress_directory THEN NULL
          ELSE private.public_free_text_or_null(
            g.safe_metadata ->> 'description', 500)
        END,
        'category', CASE
          WHEN g.is_academic THEN NULL
          WHEN g.suppress_directory THEN NULL
          ELSE private.public_free_text_or_null(
            g.safe_metadata ->> 'category')
        END,
        -- 0385: proof_url drops query + fragment AND runs the value gate, via
        -- the URL-specific cleaner that omits rather than truncates.
        'proof_url', private.public_url_or_null(
          g.safe_metadata ->> 'proof_url'),
        'issuer', CASE
          WHEN g.suppress_directory THEN NULL
          ELSE private.public_free_text_or_null(
            g.safe_metadata ->> 'issuer')
        END,
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
      -- 0415: the same value as issued_date under a second key. Suppressing
      -- one and not the other would be theatre.
      'issued_at', CASE WHEN g.suppress_directory THEN NULL ELSE a.issued_at END,
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
        WHEN g.suppress_directory THEN NULL
        ELSE private.public_free_text_or_null(a.revocation_reason, 500)
      END,
      'expires_at', CASE WHEN g.suppress_directory THEN NULL ELSE a.expires_at END,
      'source_url', private.public_url_or_null(a.metadata->>'source_url'),
      'source_provider', private.public_free_text_or_null(a.metadata->>'source_provider'),
      'verification_level', private.public_free_text_or_null(a.metadata->>'verification_level'),
      'evidence_package_hash', private.public_free_text_or_null(a.metadata->>'evidence_package_hash'),
      'source_payload_hash', private.public_free_text_or_null(a.metadata->>'source_payload_hash'),
      'fetched_at', private.public_free_text_or_null(
        COALESCE(a.metadata->>'fetched_at', a.metadata->>'source_fetched_at')),
      -- 0415: THE MEASURED LIVE LEAK. `field_of_study` is verbatim 99.3
      -- directory information ("major field of study") and `credit_hours` is
      -- the award detail beside it. All three opted-out production records
      -- carry a populated cpe_metadata, and this projection published it.
      'cpe_metadata', CASE
        WHEN g.suppress_directory THEN NULL
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
      -- 0415: the CLE twin. course_title / approved_provider_name /
      -- jurisdiction name the course and the institution -- directory
      -- information, on a credential type that IS in the FERPA set.
      'cle_metadata', CASE
        WHEN g.suppress_directory THEN NULL
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
         'jurisdiction', private.public_free_text_or_null(a.metadata->>'jurisdiction'),
         -- 0415: ADDITIVE and nullable (CLAUDE.md 1.8). It sits INSIDE the same
         -- jsonb_strip_nulls, so the key is absent unless suppression fired and
         -- no existing consumer sees a new key on an existing record. It is
         -- emitted at all because silently showing 'Unknown Issuer' for a record
         -- whose issuer IS known would be an unstated redaction (1.5), and
         -- because the REST projection already emits exactly this key.
         'directory_info_suppressed', CASE WHEN g.suppress_directory THEN true END))
  INTO
    v_recipient_raw,
    v_suppress_directory,
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
      private.is_academic_record_credential_type(a.credential_type::text) AS is_academic,
      -- 0415: hoisted for exactly the reason is_academic is -- a SQL function
      -- carrying `SET search_path` is refused by the inliner, so every
      -- reference would be a real fmgr call with GUC save/restore, and this
      -- projection references the predicate seventeen times.
      private.is_directory_info_suppressed(
        a.directory_info_opt_out, a.credential_type::text) AS suppress_directory
    OFFSET 0
  ) g
  WHERE a.public_id = p_public_id
    AND a.status IN ('SECURED', 'REVOKED', 'EXPIRED', 'SUPERSEDED', 'PENDING', 'SUBMITTED')
    AND a.deleted_at IS NULL;

  IF v_result IS NULL THEN
    RETURN jsonb_build_object('error', 'Record not found');
  END IF;

  -- 0415: the recipient identifier is OMITTED, not blanked, when the opt-out
  -- fires -- parity with the REST projection, which asserts
  -- `not.toHaveProperty('recipient_identifier')`. Omission also leaves a
  -- suppressed record indistinguishable from a record that simply has no
  -- recipient, which a sentinel value would not.
  IF NOT COALESCE(v_suppress_directory, true) THEN
    IF v_recipient_raw IS NOT NULL AND length(v_recipient_raw) > 0 AND v_recipient_pepper IS NOT NULL THEN
      v_recipient_hash := encode(
        extensions.hmac(lower(btrim(v_recipient_raw))::bytea, v_recipient_pepper::bytea, 'sha256'),
        'hex'
      );
      v_result := v_result || jsonb_build_object('recipient_identifier', v_recipient_hash);
    ELSE
      v_result := v_result || jsonb_build_object('recipient_identifier', '');
    END IF;
  END IF;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_public_anchor(text)
  IS 'Anon-callable public verification projection. Top-level keys and the '
     'metadata sub-object are explicit allow-lists (0355/0362); recipient is a '
     'keyed HMAC (0356/0383); academic records emit no issuer- or '
     'extraction-authored free text and every other type has its free text '
     'value-gated (0385, fail-closed on an absent type per 0390). 0415 adds the '
     'FERPA Section 99.37 DIRECTORY-INFORMATION layer: when '
     'private.is_directory_info_suppressed() fires, issuer_name and filename '
     'degrade to controlled labels, issuer_public_id / the award and expiry '
     'dates / cpe_metadata / cle_metadata / revocation_reason / the free-text '
     'metadata keys are dropped, recipient_identifier is omitted, and '
     'directory_info_suppressed: true is emitted. The record still VERIFIES — '
     'fingerprint, status, chain receipt and block are never gated, and the row '
     'filter is untouched, so a suppressed anchor resolves exactly as before. '
     'Mirrors services/worker/src/api/v1/verify.ts; parity is enforced by '
     'scripts/ci/public-pii-projection-contract.json.';

-- -----------------------------------------------------------------------------
-- search_public_credentials — the 0387 body with ONE added WHERE clause.
--
-- Everything else is byte-for-byte the current production body (md5
-- 6c2d77e1af8aeb2a56d316443ad090a1): the >=3-character minimum, the 1..50 limit
-- clamp, the `public_org_ids` MATERIALIZED CTE and the visibility rule, the
-- SECURED-only filter, the academic-type exclusion, the "match only on text we
-- would print" predicate pair, `ORDER BY a.created_at DESC`, `RETURNS SETOF
-- jsonb`, `STABLE SECURITY DEFINER`, `SET search_path`, `SET statement_timeout`.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_public_credentials(p_query text, p_limit integer DEFAULT 10)
  RETURNS SETOF jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
  SET statement_timeout TO '5s'
AS $$
DECLARE
  v_limit  integer;
  v_pattern text;
BEGIN
  v_limit  := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);

  IF p_query IS NULL OR length(trim(p_query)) < 3 THEN
    RETURN;
  END IF;

  v_pattern := '%' || trim(p_query) || '%';

  RETURN QUERY
  WITH public_org_ids AS MATERIALIZED (
    SELECT DISTINCT p.org_id
    FROM   profiles p
    WHERE  p.role             = 'ORG_ADMIN'
      AND  p.is_public_profile = true
      AND  p.org_id IS NOT NULL
  )
  SELECT jsonb_build_object(
    'public_id',       a.public_id,
    -- 0387: never the raw filename. Academic records get the controlled label
    -- (identical vocabulary to get_public_anchor via 0385); everything else
    -- gets the cleaned filename, falling back to the controlled label so this
    -- key is never NULL — the search UI renders it as the result heading.
    'title',           CASE
                         WHEN private.is_academic_record_credential_type(a.credential_type::text)
                           THEN private.academic_record_public_label(a.credential_type::text)
                         ELSE COALESCE(
                                private.public_free_text_or_null(a.filename),
                                private.academic_record_public_label(NULL)
                              )
                       END,
    'credential_type', a.credential_type,
    'status',          a.status,
    'created_at',      a.created_at,
    'org_id',          a.org_id
  )
  FROM  anchors a
  WHERE a.deleted_at IS NULL
    -- 0387: SECURED only. SUBMITTED is pre-publication — leaking the FILENAME
    -- of a document whose owner has published nothing is strictly worse than
    -- the existence oracle 0386 closed on the fingerprint RPC.
    AND a.status = 'SECURED'
    AND (
      a.org_id IS NULL
      OR a.org_id IN (SELECT org_id FROM public_org_ids)
    )
    -- 0387: academic records are NOT publicly searchable objects. Their only
    -- searchable fields are learner-authored free text, so excluding them here
    -- is what closes the HIT-COUNT ORACLE — suppressing the projected title
    -- alone would still let an attacker confirm a learner's name from a
    -- non-empty result set. Do not fold this into the projection.
    AND NOT private.is_academic_record_credential_type(a.credential_type::text)
    -- 0415: a record whose subject exercised the FERPA Section 99.37
    -- directory-information opt-out leaves the MATCH SET, for exactly 0387's
    -- reason one clause above: a non-empty result set is itself the
    -- disclosure. Not redundant with that clause — CLE is in the FERPA set but
    -- NOT in the academic set, so an opted-out CLE record is matchable today.
    AND NOT private.is_directory_info_suppressed(
              a.directory_info_opt_out, a.credential_type::text)
    -- 0387: match only on text we would be willing to PRINT. The cheap ILIKE is
    -- first in each branch so the planner runs the gate only on already-matched
    -- rows, never across the table.
    AND (
      (a.filename ILIKE v_pattern
        AND private.public_free_text_or_null(a.filename) IS NOT NULL)
      OR
      (a.description ILIKE v_pattern
        AND private.public_free_text_or_null(a.description, 500) IS NOT NULL)
    )
  ORDER BY a.created_at DESC
  LIMIT v_limit;
END;
$$;

COMMENT ON FUNCTION public.search_public_credentials(text, integer)
  IS 'Anon-executable public credential search. 0387: never projects a raw '
     'filename (academic records return a controlled label, others a cleaned '
     'one), excludes academic-record types from MATCHING entirely, matches only '
     'on text the projection would print, and is restricted to SECURED. 0415 '
     'additionally excludes any record whose subject exercised the FERPA '
     'Section 99.37 directory-information opt-out. The match-side rules are '
     'load-bearing, not redundant with the projection: suppressing only the '
     'returned title would still let a caller confirm a record from a non-empty '
     'result set.';

-- Deliberately NOT touched — anon-public by design and pinned as such by
-- 0364's suite. This migration changes their VALUES, never their reachability:
--   public.get_public_anchor(text)
--   public.get_public_anchor_by_fingerprint(text)   (delegates; inherits)
--   public.search_public_credentials(text, integer)

-- PostgREST caches the function catalog; reload so both redefinitions and the
-- new private helper take effect on the API surface immediately.
NOTIFY pgrst, 'reload schema';

COMMIT;
