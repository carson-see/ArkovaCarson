BEGIN;
SET LOCAL lock_timeout = '5s';

-- =============================================================================
-- 0433 — SCRUM-3529 / FD-FERPA-1 reconciliation: `get_public_anchor` must carry
--        BOTH the FERPA §99.37 directory-information suppression (0415) AND
--        the canonical `anchors.sub_type` projection (0421). Neither of those
--        two files' bodies contains the other's change, and this file is the
--        COMPENSATING migration that makes both true at once.
--
-- ─── WHY A NEW FILE, NOT AN EDIT TO 0421 ───────────────────────────────────
--
-- CLAUDE.md §1.2 / §4: never modify an existing migration once it has run
-- anywhere. `0421_scrum3529_public_anchor_sub_type_projection.sql` was applied
-- to the isolated soak rig `arkova-soak-mig-public-projection`
-- (`uayovlvdhmuovuyfxrog`, docs/staging/mig-public-projection/STANDUP.md,
-- 2026-08-30) as part of measuring the exact clobber this migration exists to
-- fix, so it is immutable — enforced mechanically by
-- `.claude/hooks/check-constitution-on-edit.sh`, which denies any edit to a
-- file already present under `supabase/migrations/`. This file is 0421's
-- compensating `CREATE OR REPLACE`, the same shape as `0360` compensating
-- `0340` (CLAUDE.md's own precedent) or `0383` restoring `0362`/`0356` after
-- `0376`'s stale-branch clobber.
--
-- ─── THE DEFECT THIS RECONCILES ────────────────────────────────────────────
--
-- Both `0415_ferpa_directory_info_opt_out_public_projections.sql` (PR #2314)
-- and `0421_scrum3529_public_anchor_sub_type_projection.sql` (PR #2440, this
-- migration's own predecessor) redefine `public.get_public_anchor` WHOLESALE,
-- and neither body contains the other's change — `0421`'s body was branched
-- from `0385` (the pre-0415 head) while both PRs were open, exactly the branch-
-- from-a-file-not-the-live-definition mistake CLAUDE.md's `sql_owner_migration`
-- convention exists to prevent (the 0376 incident).
--
-- Measured directly on the isolated soak rig, same nine anchors, same
-- anonymous caller, minutes apart (docs/staging/mig-public-projection/
-- STANDUP.md, phase1-0415-rpc-capture.json vs phase2-0421-rpc-capture.json):
-- applying 0415 then 0421 in numeric order SILENTLY REVERTS the entire FERPA
-- suppression layer while leaving `private.is_directory_info_suppressed`
-- installed but orphaned from `get_public_anchor` — precisely the failure mode
-- 0415 exists to fix, reintroduced by merge order. The clobber is bidirectional
-- (reapplying 0415 last reverses `sub_type` instead); no application order of
-- the two files alone yields a head carrying both changes.
--
-- 0415 was subsequently applied directly to PRODUCTION by RTE ahead of PR
-- #2314's merge (ledger-reconciled to numeric '0415' per CLAUDE.md §0 rule 10
-- / the migration-drift ledger exemption), so by the time this reconciliation
-- was written, production was ALREADY running the FERPA-suppressing body.
-- Merging `0421` unmodified and later applying it would not be a hypothetical
-- risk to reason about — it is what literally happens: a live regression of a
-- FERPA compliance control already enforced in production.
--
-- ─── WHAT THIS MIGRATION DOES ──────────────────────────────────────────────
--
-- Redefines `public.get_public_anchor` ONE more time: the body is 0415's
-- verbatim (`private.is_directory_info_suppressed`, the `g.suppress_directory`
-- hoist, every directory-information suppression branch, the
-- `directory_info_suppressed` additive key, the omitted-not-blanked
-- `recipient_identifier`), with 0421's single addition layered on top —
-- a directory-gated canonical `sub_type`, placed immediately after
-- `credential_type`. Its non-suppressed value uses public_free_text_or_null.
--
-- `sub_type` is suppressed whenever `g.suppress_directory` applies. Unlike
-- credential_type, it is arbitrary text with no enum or CHECK. The matching
-- worker change gates API_RICH_KEYS on suppressDirectory too, so the field
-- cannot be recovered from the other anonymous surface. Published records
-- retain the canonical value, gated by public_free_text_or_null.
--
-- `public.search_public_credentials` is deliberately NOT touched by this
-- migration. `0421` never redefined it; `0415` already added the directory-
-- info exclusion to it, and that change is untouched and unaffected by
-- anything here.
--
-- `get_public_anchor_by_fingerprint` needs no change: it resolves a public_id
-- and returns `public.get_public_anchor(v_public_id)` verbatim, so it inherits
-- this reconciliation completely.
--
-- ─── PRECONDITION — READ BEFORE APPLYING TO ANY ENVIRONMENT ────────────────
--
-- This migration's body calls `private.is_directory_info_suppressed(boolean,
-- text)`, which is CREATEd by
-- `supabase/migrations/0415_ferpa_directory_info_opt_out_public_projections.sql`
-- (PR #2314). `CREATE OR REPLACE FUNCTION ... LANGUAGE plpgsql` is NOT
-- validated against the catalog at creation time, so applying this file to an
-- environment where 0415 has not ALSO been applied will still succeed at
-- CREATE and then fail at CALL TIME — "function
-- private.is_directory_info_suppressed(boolean, text) does not exist" — on
-- every single call to the anonymous public verify page. That is a P0-shaped
-- outage of the primary verification surface, not a soft degradation.
--
-- Production already satisfies this precondition (0415 is live). A fresh
-- environment that replays `supabase/migrations/` in file order — an isolated
-- soak rig, `supabase db reset`, a new dev database — does NOT satisfy it
-- until 0415's own file also exists in that migrations directory at its lower
-- numeric prefix. As of this migration's authorship that is true only on PR
-- #2314's branch, not on `main`. PR #2314 merging (or 0415's file otherwise
-- landing on `main` ahead of this one) is therefore a precondition for THIS
-- migration merging safely, not merely for applying it. If this migration
-- reaches `main` first, whoever applies it to a fresh environment MUST apply
-- 0415 first or this migration second in the same batch.
--
-- ─── TIER AND ENVELOPE ──────────────────────────────────────────────────────
--
-- SECURITY DEFINER + `SET search_path TO 'public'` preserved (CLAUDE.md §1.4).
-- No signature change and no DROP, so the ACL carries through unchanged —
-- anon-callable by design, pinned by `0364`'s suite
-- (`scripts/ci/feedback-rules/secdef-function-grants.ts` `DELIBERATELY_PUBLIC`).
--
-- CLAUDE.md §1.8: no field is renamed, retyped or removed. `sub_type` and
-- `directory_info_suppressed` are both additive and nullable/absent-by-default.
--
-- Tier: T3 (redefines a public, anon-callable projection RPC; carries a
-- FERPA-compliance-relevant suppression layer forward. Prod-apply is
-- RTE/CTO-owned — NOT applied by this session.)
--
-- ─── ROLLBACK ──────────────────────────────────────────────────────────────
--
-- ROLLBACK: Restore the 0415 definition of `public.get_public_anchor` verbatim
-- ROLLBACK: — re-run the `CREATE OR REPLACE FUNCTION
-- ROLLBACK: public.get_public_anchor(p_public_id text)` block from
-- ROLLBACK: supabase/migrations/0415_ferpa_directory_info_opt_out_public_projections.sql,
-- ROLLBACK: which is this file's body without the added
-- ROLLBACK: directory-gated `sub_type` projection,
-- ROLLBACK: then `NOTIFY pgrst, 'reload schema';`. Do NOT roll back further to
-- ROLLBACK: 0385 or to 0421's original (pre-reconciliation) form — either would
-- ROLLBACK: ALSO revert the FERPA directory-information suppression layer,
-- ROLLBACK: republishing directory information for every opted-out learner,
-- ROLLBACK: which is a strictly worse outcome than leaving sub_type
-- ROLLBACK: unprojected. No schema change, no data migration, no flag: a
-- ROLLBACK: correctly-scoped rollback only stops emitting sub_type; FERPA
-- ROLLBACK: suppression is unaffected either way.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- get_public_anchor — 0415's body (FERPA Section 99.37 directory-information
-- suppression intact) with 0421's single `sub_type` key layered on top. Every
-- line except the `-- 0433:` marker and the new clause is byte-identical to
-- 0415.
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
      -- 0433 (SCRUM-3529, reconciling 0421 onto 0415): the CANONICAL
      -- anchors.sub_type column, immediately after the parent type it refines.
      -- VALUE-GATED, never raw: sub_type is bare `text` with no CHECK and no
      -- enum, so arbitrary issuer-authored content must respect directory
      -- suppression as well as the value cleaner. SQL emits explicit null;
      -- the optional REST field is omitted for the same suppressed record.
      'sub_type', CASE WHEN g.suppress_directory THEN NULL
                       ELSE private.public_free_text_or_null(a.sub_type) END,
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
         --
         -- 0433: reformatted onto its own closing line (vs. 0415's original
         -- trailing `END))`) so the contract test's `projectedKeys()` line-
         -- opening parser terminates on this key correctly. Purely
         -- whitespace — the expression and its semantics are unchanged.
         'directory_info_suppressed', CASE WHEN g.suppress_directory THEN true END
       ))
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
     'directory_info_suppressed: true is emitted. 0433 reconciles 0421''s '
     'canonical anchors.sub_type addition onto this body: sub_type is a '
     'value-gated top-level key, NOT suppressed by the directory-info gate '
     '(parity with credential_type''s recorded residual and verify.ts, '
     'SCRUM-3529), so the public verify page can render a credential sub-type '
     'instead of the generic "Other". The record still VERIFIES — fingerprint, '
     'status, chain receipt and block are never gated, and the row filter is '
     'untouched, so a suppressed anchor resolves exactly as before. Mirrors '
     'services/worker/src/api/v1/verify.ts; parity is enforced by '
     'scripts/ci/public-pii-projection-contract.json.';

-- PostgREST caches the function catalog; reload so the redefinition takes
-- effect on the API surface immediately.
NOTIFY pgrst, 'reload schema';

COMMIT;
