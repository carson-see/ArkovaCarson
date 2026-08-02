BEGIN;

-- =============================================================================
-- 0385 — get_public_anchor: value-level PII gate + academic-record free-text
--        suppression on the ANON-GRANTED public projection.
--
-- ── WHICH DEFINITION THIS IS BASED ON (read this before writing an 0386) ─────
--
--   BASE: the LIVE PRODUCTION definition of public.get_public_anchor as of
--   2026-08-01, captured via
--       SELECT pg_get_functiondef(oid) FROM pg_proc
--        WHERE proname = 'get_public_anchor';
--   on project `vzwyaatejekddvltxyye`. That is the 0383 body — i.e. 0311 + 0331
--   + 0355 (metadata allow-list) + 0356 (keyed recipient HMAC) + 0362 (CE
--   registry allow-list keys) + 0376 (fingerprint_source) + 0383 (restoration
--   of the 0356/0362 content that 0376 clobbered).
--
--   NOT based on any single earlier migration FILE. On 2026-08-01, migration
--   0376 was branched from the 0355 file instead of the then-current head; its
--   CREATE OR REPLACE silently reverted 0356's keyed HMAC and 0362's allow-list,
--   and an unsalted, dictionary-reversible SHA-256 of recipient e-mail addresses
--   was live on an anon-callable endpoint for four days before 0383 repaired it.
--
--   `get_public_anchor` is redefined WHOLESALE by every migration that touches
--   it. There is no partial edit. ALWAYS take the current body from prod (or
--   from the highest-numbered migration that redefines the function), diff your
--   change against THAT, and say here which one you used.
--
--   NUMBERING: originally authored as 0384 and renumbered. While it was in
--   review, `0384_scrum2481_anchor_evidence_claim_authority` (PR #1806) was
--   applied to prod out of band without first reserving the prefix in
--   supabase/migrations/agents.md — the exact collision that reservation rule
--   exists to prevent. Verified against the live ledger on
--   `vzwyaatejekddvltxyye`: 0379, 0380, 0381, 0383, 0384 = scrum2481. Hence 0385.
--
--   Because 0362/0383 live on an unmerged branch (PR #1618), a freshly reset
--   local/CI database builds 0311 -> ... -> 0376 and therefore lacks the HMAC
--   and the CE registry keys. This migration carries the full prod body, so
--   after it applies EVERY environment converges on the same definition
--   regardless of whether #1618 has landed. Applying 0362/0383 later is a no-op
--   with respect to this file: 0385 sorts last and wins.
--
-- ── THE DEFECT ───────────────────────────────────────────────────────────────
--
--   public.get_public_anchor(text) and its delegating sibling
--   public.get_public_anchor_by_fingerprint(text) (0339) are GRANTed to `anon`
--   and are called directly, unauthenticated, by the public verification page
--   (src/components/verification/PublicVerification.tsx), by the embeddable
--   VerificationWidget, and by the edge MCP `verify` tools.
--
--   Every free-text field on that projection was emitted VERBATIM:
--
--     * `filename`                — raw column. The verify page renders it as
--                                   the record's display title AND embeds it in
--                                   schema.org JSON-LD, so
--                                   `jane-doe-transcript.pdf` published a
--                                   learner's name to anonymous callers and to
--                                   search-engine structured data.
--     * `revocation_reason`       — raw column ("revoked - contact
--                                   jane@example.edu").
--     * `issuer_name`             — raw `metadata->>'issuer'`, not even passed
--                                   through sanitize_metadata_for_public.
--     * `metadata.title`,
--       `metadata.credential_title`,
--       `metadata.description`,
--       `metadata.category`,
--       `metadata.issuer`         — routed through
--                                   sanitize_metadata_for_public, which is a
--                                   key-NAME denylist (baseline, l.6046): it
--                                   drops keys CALLED `recipient`/`email`/`dob`/
--                                   `student_id` and NEVER inspects a VALUE. A
--                                   learner name (or an e-mail, or an SSN)
--                                   written into a credential title is not a
--                                   banned key name, so it reached `anon`
--                                   verbatim.
--
--   This is the same defect class fixed on the CTDL projection in PR #1815
--   (services/worker/src/ctdl/ctdl-pii-guard.ts). Until this migration the two
--   public paths were ASYMMETRIC: the CTDL path scrubbed revocation_reason and
--   suppressed academic-record free text, while the SQL path — reachable by the
--   same anonymous caller, over PostgREST, with no worker in the loop — shipped
--   all of it raw.
--
-- ── THE FIX (mirrors ctdl-pii-guard.ts; see the parity contract) ─────────────
--
--   Structural layer (academic records). DEGREE / CERTIFICATE / TRANSCRIPT are
--   records ABOUT AN IDENTIFIED LEARNER, so they emit NO issuer- or
--   extraction-authored free text at all:
--       filename
--           -> a CONTROLLED-VOCABULARY label derived only from the
--              credential_type enum ('Academic Transcript' / 'Academic Degree' /
--              'Certificate'). Never NULL, because the verify page renders this
--              as the record's display title and embeds it in schema.org
--              JSON-LD, so a consumer assuming a non-empty string must not break.
--       metadata.title / metadata.credential_title / metadata.description /
--       metadata.category / revocation_reason
--           -> omitted. (title/credential_title are OMITTED rather than given
--              the label: leaving `metadata` non-empty flips the verify card
--              into its key-value render mode and would print the label three
--              times. See the inline note at the projection.)
--   This is precision-INDEPENDENT. It is deliberately NOT a name detector: PR
--   #1815 measured a learner-name heuristic against real inputs and it 404'd 28
--   of 32 real institution names while still missing bare, all-caps, and
--   non-ASCII names. A finite word list cannot veto an open class (proper
--   nouns). Do not reintroduce one here as a gate.
--
--   Value layer (EVERY credential type). Every emitted string passes through
--   private.public_free_text_or_null(), which drops the value when it carries
--   FORMAT- or KEYWORD-anchored PII (e-mail, US phone, international phone, SSN,
--   keyword-anchored date of birth, keyword-anchored student/learner/enrolment
--   ID). Emitted URLs use private.public_url_or_null() instead, which strips the
--   query string and fragment and DROPS rather than truncates.
--
--   No learner-name heuristic runs on this path. That is a deliberate,
--   measured divergence from the CTDL serializer — see the long note on
--   public_free_text_or_null below, and the shared contract.
--
--   OMISSION, NOT FAIL-CLOSED — and that divergence from the CTDL path is
--   deliberate. On the CTDL path the whole body is a PUBLICATION to an external
--   registry, so refusing to publish is the right answer and the route 404s. On
--   THIS path the body is a VERIFICATION ANSWER: refusing it would tell an
--   anonymous verifier that a genuinely anchored document does not exist,
--   breaking the core product guarantee, in exchange for nothing — the
--   verification-bearing fields (fingerprint, chain receipt, status, block
--   height) carry no free text and therefore no PII. Dropping the offending
--   FIELD contains the leak completely while the verification still answers.
--
--   `source_url` already dropped its query string and fragment; `proof_url` now
--   does too. Structural, not heuristic: a query parameter is the carrier an
--   identifier rides in on, and a public proof link never needs one.
--
-- ── ANTI-DRIFT ───────────────────────────────────────────────────────────────
--
--   The whole reason this gap existed is that two implementations of one rule
--   drifted. FOUR mechanisms. 1-3 run in the DEFAULT test suite (no database);
--   4 runs under vitest.config.rls.ts against a live database, which CI provides
--   via `supabase db reset` + `npm run test:rls` (.github/workflows/ci.yml):
--
--   1. scripts/ci/public-pii-projection-contract.json is the SHARED CONTRACT —
--      the academic-record type set, the controlled labels, the suppressed
--      fields, the detector families, and a vector corpus of strings with their
--      expected verdicts.
--   2. src/tests/public-anchor-pii-projection.contract.test.ts asserts THIS
--      migration implements the contract, and asserts the SELF-ARMING TS half:
--      the moment services/worker/src/ctdl/ctdl-pii-guard.ts exists on main
--      (PR #1815), its EDUCATION_CREDENTIAL_TYPES must equal the contract's.
--   3. The same test enforces the LATEST-DEFINITION INVARIANT: whichever
--      migration file redefines get_public_anchor with the HIGHEST numeric
--      prefix must still contain the PII-gate markers. A future 0386 branched
--      from a stale file — the exact 0376 mistake — fails CI instead of
--      silently reopening this hole in production.
--   4. tests/rls/public-anchor-pii-projection.test.ts runs the contract's
--      vector corpus end to end through the REAL function as an ANON client.
--
-- ── ENVELOPE ─────────────────────────────────────────────────────────────────
--
--   SECURITY DEFINER + SET search_path = public preserved (CLAUDE.md §1.4).
--   Status filter, deleted_at guard, keyed recipient HMAC, top-level allow-list,
--   metadata allow-list, cpe/cle allow-lists: all unchanged. Grants unchanged
--   (get_public_anchor stays anon-callable — it is a deliberately public
--   verification endpoint). Helper functions are NOT SECURITY DEFINER; they run
--   as the definer inside get_public_anchor, and are revoked from
--   PUBLIC/anon/authenticated so PostgREST cannot expose them as RPCs.
--
--   §1.8: no field is added, renamed, removed, or made non-nullable. Only
--   VALUES narrow. No API version bump.
--   §1.13 R-7: no external-status claim added or changed.
--
--   TIER: T3 (supabase/migrations/ + a security-sensitive anon-GRANTed
--   projection). Prod-apply is RTE/Carson-owned — NOT applied by this session.
--
-- ROLLBACK:
--   Restore the prior definition — the LIVE PROD (0383) body — by re-applying
--   supabase/migrations/0383_scrum2913_get_public_anchor_restore_hmac_and_registry_keys.sql
--   (PR #1618). That file is the byte-for-byte source of the body this migration
--   was diffed against, so re-applying it reverts every change made here in one
--   statement. Then:
--       DROP FUNCTION IF EXISTS private.public_url_or_null(text);
--       DROP FUNCTION IF EXISTS private.public_free_text_or_null(text, integer);
--       DROP FUNCTION IF EXISTS private.contains_high_confidence_pii(text);
--       DROP FUNCTION IF EXISTS private.academic_record_public_label(text);
--       DROP FUNCTION IF EXISTS private.is_academic_record_credential_type(text);
--       NOTIFY pgrst, 'reload schema';
--   If #1618 has not landed in the target environment, the equivalent body is
--   recoverable from prod history via pg_get_functiondef before this apply.
--   Reverting restores the previous (leaking) behaviour. No data migration to
--   reverse: this migration changes no rows and no schema.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- All helpers live in the `private` schema, NOT `public`.
--
-- `private` already exists in this database (created by 0299 for the API-key
-- HMAC secret) and is deliberately absent from `supabase/config.toml`'s
-- `schemas = ["public", "graphql_public"]`, so PostgREST never introspects it:
-- these functions are structurally unreachable over the API rather than
-- reachable-but-revoked, they never enter `src/types/database.types.ts` (and so
-- never ship to the browser), and there is no per-function grant to forget.
--
-- That last point is not theoretical. `0378_sec_recon_revoke_deferred_security_definer_grants.sql`
-- exists solely to revoke anon/authenticated from 50 over-granted `public`
-- functions after an unauthenticated PostgREST call reached a worker-only RPC.
-- Internal machinery does not belong in `public`.
--
-- The schema-level REVOKE/GRANT from 0299 is re-asserted here so this migration
-- is self-contained if it is ever replayed against a database that lacks it.
-- `get_public_anchor` stays SECURITY DEFINER owned by `postgres`, which holds
-- USAGE on `private`, so the schema-qualified calls resolve for anon callers.
-- -----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO service_role;

-- -----------------------------------------------------------------------------
-- Academic-record credential types.
--
-- Mirrors EDUCATION_CREDENTIAL_TYPES in ctdl-pii-guard.ts. CPE/CLE are
-- deliberately EXCLUDED: continuing professional education is a practitioner
-- record, not a FERPA academic record, and its descriptive title is the
-- partner-facing value. EVERY addition to this set silently replaces real
-- credential titles with generic ones — widen only with a documented privacy
-- reason, in the shared contract, in the same change.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.is_academic_record_credential_type(p_credential_type text)
  RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  SET search_path = private, public
AS $$
  SELECT upper(COALESCE(p_credential_type, '')) IN ('DEGREE', 'CERTIFICATE', 'TRANSCRIPT');
$$;

-- -----------------------------------------------------------------------------
-- Controlled-vocabulary public label for an academic record.
--
-- Derived ONLY from the credential_type enum — no issuer text, no extraction
-- output, no metadata — so there is nothing for a learner identity to ride in
-- on. Deliberately coarser than the CTDL serializer's academicRecordName(),
-- which resolves a degree LEVEL ('Master Degree') from the CTDL @type map; that
-- map does not exist in the database, so DEGREE flattens to 'Academic Degree'.
-- Documented divergence, pinned in the shared contract — not silent drift.
--
-- COPY SURFACE WARNING: these strings are USER-VISIBLE — the verify page renders
-- `filename` as the record's display title and embeds it in schema.org JSON-LD.
-- They live in SQL, so `npm run lint:copy` (which scans TS/TSX for the §1.3
-- banned terminology) structurally CANNOT see them. None of the current labels
-- contains a banned term. If this set is ever widened, check the new label
-- against CLAUDE.md §1.3 BY HAND — no linter will do it for you.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.academic_record_public_label(p_credential_type text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  SET search_path = private, public
AS $$
  SELECT CASE upper(COALESCE(p_credential_type, ''))
    WHEN 'TRANSCRIPT'  THEN 'Academic Transcript'
    WHEN 'DEGREE'      THEN 'Academic Degree'
    WHEN 'CERTIFICATE' THEN 'Certificate'
    ELSE 'Secured Document'
  END;
$$;

-- -----------------------------------------------------------------------------
-- High-confidence PII detector — FORMAT- or KEYWORD-anchored values only.
--
-- Line-for-line mirror of containsHighConfidencePii() in ctdl-pii-guard.ts. The
-- JS -> POSIX ARE translation is mechanical and is exactly one substitution:
-- word boundary `\b` becomes `\y`. Case-insensitive JS flags become the `~*`
-- operator. Everything else — bounded separator classes, quantifiers,
-- non-capturing groups — is written identically in both dialects.
--
-- Every separator is a BOUNDED class (`[\s:#-]{0,4}`) and never the `\s*X?\s*`
-- shape, which enumerates O(n^2) splits of a whitespace run before failing.
-- Input is capped at 4000 characters (MAX_SCAN_CHARS) because this runs on raw
-- database text behind a public, unauthenticated endpoint.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.contains_high_confidence_pii(p_text text)
  RETURNS boolean
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path = private, public
AS $$
DECLARE
  v_text  text;
  v_match text;
BEGIN
  IF p_text IS NULL THEN
    RETURN false;
  END IF;

  -- normalizeForScan(): cap, strip control characters (so a NUL cannot split a
  -- value out from under a detector), collapse whitespace, trim.
  v_text := btrim(
    regexp_replace(
      regexp_replace(left(p_text, 4000), '[[:cntrl:]]', '', 'g'),
      '\s+', ' ', 'g'
    )
  );

  IF v_text = '' THEN
    RETURN false;
  END IF;

  -- EMAIL_PATTERN
  IF v_text ~* '\y[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\y' THEN
    RETURN true;
  END IF;

  -- SSN_SEPARATED_PATTERN. Separators are MANDATORY here: the bare-9-digit form
  -- matches any bounded digit run (an order number, a numeric path segment in
  -- an issuer URL), which would drop legitimate fields wholesale. The keyword
  -- form below covers the unseparated case.
  IF v_text ~ '\y\d{3}[-\s]\d{2}[-\s]\d{4}\y' THEN
    RETURN true;
  END IF;

  -- SSN_KEYWORD_PATTERN
  IF v_text ~* '\y(?:ssn|social\ssecurity(?:\s(?:no|number|#))?)\y[\s:#-]{0,4}\d{3}[-\s]?\d{2}[-\s]?\d{4}\y' THEN
    RETURN true;
  END IF;

  -- US_PHONE_PATTERN
  IF v_text ~ '(?:\+1\d{10}|\(\d{3}\)\s?\d{3}[-.]?\d{4}|\y\d{3}[-.\s]\d{3}[-.\s]\d{4}\y)' THEN
    RETURN true;
  END IF;

  -- DOB_PATTERN (SCRUM-2299). Keyword-anchored: a bare date is far too common in
  -- credential copy ('Academic year 2024-2025') to treat as PII on its own.
  IF v_text ~* '(?:\yd\.?\s?o\.?\s?b\.?|\ydate\sof\sbirth\y|\ybirth\s?date\y|\ybirthdate\y|\yborn(?:\son)?\y)[\s:–—-]{0,4}(?:\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]{0,9}\s\d{1,2},?\s\d{4}|\d{1,2}\s(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]{0,9}\s\d{4}|\d{4})' THEN
    RETURN true;
  END IF;

  -- STUDENT_ID_PATTERN (SCRUM-2299). Keyword-anchored AND digit-bearing (>= 4
  -- digits) so a bare word ('Student') or a course code ('PHIL 2020') cannot
  -- trip it.
  IF v_text ~* '\y(?:(?:student|learner|enroll?ment|matriculation|candidate|registrant|pupil)\s?(?:id|i\.d\.|no\.?|number|#)|s\.?i\.?d\.?)\y[\s:#–—-]{0,4}[A-Za-z]{0,4}-?\d{4,}' THEN
    RETURN true;
  END IF;

  -- International phone. The pattern only proposes a CANDIDATE; the E.164 digit
  -- count is checked procedurally, exactly as containsInternationalPhone() does
  -- in code, so a short false match like '+1 2026-03-27' (9 digits) is rejected
  -- without an unreadable regex.
  --
  -- Every international number starts with '+', and regexp_matches is a
  -- set-returning function whose fixed setup cost (~0.0017 ms) is paid even when
  -- nothing can possibly match — which is the common case here, since most
  -- gated values are titles and hashes. This guard is ~30% of the detector's
  -- cost on a sha256-shaped value, multiplied by ~26 detector calls per request.
  IF strpos(v_text, '+') = 0 THEN
    RETURN false;
  END IF;

  FOR v_match IN
    SELECT m[1]
    FROM regexp_matches(v_text, '(\+\d{1,3}(?:[\s.-]\d{1,5}){2,5})', 'g') AS m
  LOOP
    IF length(regexp_replace(v_match, '\D', '', 'g')) BETWEEN 10 AND 15 THEN
      RETURN true;
    END IF;
  END LOOP;

  RETURN false;
END;
$$;

-- -----------------------------------------------------------------------------
-- public_free_text_or_null — the single value gate for every emitted string.
--
-- Hygiene, then the high-confidence detectors. Returns NULL (honest omission)
-- rather than raising, so a verification answer is still returned with the
-- offending field absent.
--
-- ── NO LEARNER-NAME HEURISTIC RUNS HERE, AND THAT IS DELIBERATE ─────────────
--
-- `ctdl-serializer.ts` / `ctdl-pii-guard.ts` carry two narrow capitalised-pair
-- patterns (`(?:for|learner|student|recipient|issued to|...)\s<Name> <Name>`,
-- and `<Name> <Name>\s(?:transcript|certificate|degree|...)`) used for
-- field-level suppression. They are NOT reproduced on this path. Measured, not
-- assumed:
--
--   * On the leak shapes this migration exists to stop, they detect NOTHING.
--     Run against the shared contract's `leak_vectors`, both patterns return
--     false for every one — bare ("Jane Doe"), all-caps ("MARIA GONZALEZ"),
--     non-ASCII ("José García"), record-noun-first ("Transcript: Jane Doe"),
--     apostrophe ("Michael O'Brien"), hyphenated ("Ana-Lucia Fernandez").
--     `[A-Z][a-z]{1,}` cannot express those shapes. Zero true positives.
--
--   * On legitimate credential text they fire constantly, because `for` is a
--     bare preposition: "Center for Professional Development", "Society for
--     Human Resource Management", "Institute for Supply Management", "Alliance
--     for Continuing Education", "Ethics for Trial Lawyers", "Credit for Prior
--     Learning", "Revoked for Non Payment" — all dropped. The second pattern
--     takes ordinary titles the same way: "Data Science degree", "Project
--     Management certificate".
--
-- A detector with zero measured true positives and abundant measured false
-- positives has negative value, and the cost here is higher than on the CTDL
-- path: these same fields are the verify page's PRIMARY DISPLAY (`filename` is
-- the record title and its schema.org `name`), not optional JSON-LD properties.
-- Learner names ARE covered on this path — structurally, by the rule above:
-- an academic record emits no issuer- or extraction-authored free text at all,
-- which is precision-independent and catches every shape above.
--
-- This divergence from the CTDL path is recorded in
-- scripts/ci/public-pii-projection-contract.json. Do not "restore parity" by
-- reintroducing these patterns here without re-measuring both halves.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.public_free_text_or_null(p_text text, p_max_length integer DEFAULT 240)
  RETURNS text
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path = private, public
AS $$
DECLARE
  v_text text;
BEGIN
  IF p_text IS NULL THEN
    RETURN NULL;
  END IF;

  -- CAP BEFORE NORMALISING. `anchors.metadata` has no size constraint beyond
  -- "is an object", so any authenticated org member can plant megabyte values,
  -- and this function is invoked ~20x per row on a PUBLIC, UNAUTHENTICATED
  -- endpoint. Normalising first ran two full-length regexp_replace passes over
  -- the untruncated input — measured at 70 ms per call on a 1 MB value (vs
  -- 1.6 ms capped), which at the documented anon rate limit is ~60 CPU-seconds
  -- per minute from a single IP. The cap is taken above both the emitted field
  -- length and MAX_SCAN_CHARS, so the visible output is byte-identical.
  v_text := left(p_text, GREATEST(p_max_length, 4000));

  v_text := btrim(
    regexp_replace(regexp_replace(v_text, '[[:cntrl:]]', '', 'g'), '\s+', ' ', 'g')
  );

  IF v_text = '' THEN
    RETURN NULL;
  END IF;

  -- left() already returns the string unchanged when it is shorter.
  v_text := left(v_text, p_max_length);

  IF private.contains_high_confidence_pii(v_text) THEN
    RETURN NULL;
  END IF;

  RETURN v_text;
END;
$$;

-- -----------------------------------------------------------------------------
-- public_url_or_null — the URL variant, which DROPS instead of TRUNCATING.
--
-- A URL is not prose. `public_free_text_or_null` truncates at its length cap,
-- which for a URL produces a VALID-LOOKING WRONG LINK that the frontend renders
-- as a live anchor — strictly worse than omitting the field. So this one drops
-- on overflow.
--
-- It also strips the query string and fragment FIRST, before the PII scan:
-- structural, not heuristic. A query parameter is where an identifier rides into
-- an otherwise innocuous field (`?student=jane%40example.edu`), and a public
-- proof, source, or registry link never needs one.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.public_url_or_null(p_url text)
  RETURNS text
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path = private, public
AS $$
DECLARE
  v_url text;
BEGIN
  IF p_url IS NULL THEN
    RETURN NULL;
  END IF;

  -- Drop the carrier before scanning the payload.
  v_url := regexp_replace(split_part(p_url, '#', 1), '\?.*$', '');
  v_url := btrim(
    regexp_replace(regexp_replace(v_url, '[[:cntrl:]]', '', 'g'), '\s+', ' ', 'g')
  );

  IF v_url = '' THEN
    RETURN NULL;
  END IF;

  -- Well beyond any legitimate public link, and below MAX_SCAN_CHARS so the
  -- detector below always sees the whole value.
  IF length(v_url) > 2048 THEN
    RETURN NULL;
  END IF;

  IF private.contains_high_confidence_pii(v_url) THEN
    RETURN NULL;
  END IF;

  RETURN v_url;
END;
$$;

-- -----------------------------------------------------------------------------
-- private.public_jsonb_text_or_null — the value gate for a jsonb sub-object key,
-- WITHOUT changing the emitted JSON type.
--
-- The cpe_metadata / cle_metadata sub-objects are key-name ALLOW-LISTS with no
-- value gate — the same defect class this migration fixes one layer up — and
-- `src/hooks/useOrgCpeMemberSummary.ts` states in-repo that the cpe blob carries
-- member PII (participant name, licence number). Gating only `course_title`
-- while `approved_provider_name` five lines above stayed raw would have been an
-- arbitrary line.
--
-- Applied to EVERY key in both sub-objects, deliberately. A numeric, boolean, or
-- object value is passed through untouched (only `jsonb_typeof = 'string'` is
-- cleaned), so this is a no-op on the structured keys and cannot become a §1.8
-- type change — while a NEW string key added to either object is gated by
-- default instead of opt-in.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.public_jsonb_text_or_null(p_value jsonb)
  RETURNS jsonb
  LANGUAGE sql
  IMMUTABLE
  SET search_path = private, public
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_value) = 'string'
      THEN to_jsonb(private.public_free_text_or_null(p_value #>> '{}'))
    ELSE p_value
  END;
$$;

-- Helpers are internal machinery for the projection, not public RPCs. They are
-- not SECURITY DEFINER, so get_public_anchor executes them as its own definer
-- and needs no grant here. service_role keeps EXECUTE so the worker and the
-- live parity suite can exercise the detectors directly (0377/0378 policy).
REVOKE ALL ON FUNCTION private.is_academic_record_credential_type(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.academic_record_public_label(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.contains_high_confidence_pii(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.public_free_text_or_null(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.public_url_or_null(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.public_jsonb_text_or_null(jsonb) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION private.is_academic_record_credential_type(text) TO service_role;
GRANT EXECUTE ON FUNCTION private.academic_record_public_label(text) TO service_role;
GRANT EXECUTE ON FUNCTION private.contains_high_confidence_pii(text) TO service_role;
GRANT EXECUTE ON FUNCTION private.public_free_text_or_null(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION private.public_url_or_null(text) TO service_role;
GRANT EXECUTE ON FUNCTION private.public_jsonb_text_or_null(jsonb) TO service_role;

-- =============================================================================
-- get_public_anchor — LIVE PROD (0383) BODY, with the free-text projection
-- narrowed. Everything else is byte-identical to what production runs today.
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
     'dropped when it carries format- or keyword-anchored PII. Mirrors '
     'services/worker/src/ctdl/ctdl-pii-guard.ts; parity is enforced by '
     'scripts/ci/public-pii-projection-contract.json.';

NOTIFY pgrst, 'reload schema';

COMMIT;
