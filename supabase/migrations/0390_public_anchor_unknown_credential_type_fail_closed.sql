-- 0390 — SCRUM-3102: the academic free-text gate must FAIL CLOSED on an absent
-- credential type.
--
-- ─── THE DEFECT ────────────────────────────────────────────────────────────
--
-- 0385 suppresses issuer- and extraction-authored free text for academic
-- records, keyed on:
--
--     upper(COALESCE(p_credential_type, '')) IN ('DEGREE','CERTIFICATE','TRANSCRIPT')
--
-- For an anchor with NO credential type that evaluates `'' IN (...)` → FALSE,
-- so the row takes the PERMISSIVE branch of `get_public_anchor` and publishes
-- `filename` — the record's public display title, and its schema.org `name` —
-- through `public_free_text_or_null`. That value gate carries seven format- or
-- keyword-anchored detector families (email, separated SSN, keyword SSN, US
-- phone, international phone, keyword DOB, keyword student ID); a bare personal
-- name matches none of them, so `jane-doe-award.pdf` is published verbatim to
-- anonymous callers.
--
-- Confirmed live in prod 2026-08-02 (0385 is applied ahead of PR #1841):
--
--     SELECT private.is_academic_record_credential_type(NULL);      -- false
--     SELECT private.public_free_text_or_null('jane-doe-award.pdf');
--     --  'jane-doe-award.pdf'
--
-- Prod scale: 59 anchors have `credential_type IS NULL`, and 24 of them (41%)
-- carry a filename matching a two-word personal-name shape — the densest such
-- pocket in a 3,363,788-row corpus. For comparison, the academic types 0385
-- does cover hold 21, and all other non-academic types hold 50 (the residual
-- accepted in docs/compliance/pentest-scope.md §4.5).
--
-- ─── WHY THE PREDICATE FLIPS INSTEAD OF get_public_anchor BEING REDEFINED ───
--
-- This is the contract's own `structural_keys` principle applied one level up:
-- "Recognising danger fails open; recognising safety fails closed." The
-- academic set recognises SAFETY by enumeration, so anything the enumeration
-- cannot positively classify must be suppressed, not waved through.
--
-- Changing ONLY this predicate reuses 0385's existing branches unmodified:
--
--   * `filename`  → `academic_record_public_label(a.credential_type::text)`,
--     and `academic_record_public_label(NULL)` already returns the non-academic
--     fallback label 'Secured Document' (verified in prod), so an untyped record
--     gets a controlled label and never a NULL display title.
--   * `metadata.title` / `credential_title` / `description` / `category` and
--     `revocation_reason` → NULL, i.e. omitted after `jsonb_strip_nulls`.
--
-- It also leaves 0385 as the LATEST migration that redefines `get_public_anchor`,
-- so `src/tests/public-anchor-pii-projection.contract.test.ts` keeps deriving
-- the projection/ungated key sets from the same file. Reproducing that ~200-line
-- body here to change one boolean would put the pinned key sets at risk for no
-- behavioural gain.
--
-- A PRESENT but non-academic type still publishes. `anchors.credential_type` is
-- an enum column, so a non-empty value is always a known type; blanking those
-- would destroy the descriptive titles that are the partner-facing value of
-- CPE/CLE and of every ordinary record.
--
-- The identical defect exists on the CTDL path (`isEducationCredentialType`
-- returns false for null) and is fixed in the same story via
-- `suppressesRecordFreeText` in `services/worker/src/ctdl/ctdl-pii-guard.ts`.
--
-- Tier: T3 (migration + security + public contract).
--
-- ─── ROLLBACK ──────────────────────────────────────────────────────────────
--
-- ROLLBACK: Restore the 0385 definition (reopens the fail-open):
-- ROLLBACK:   CREATE OR REPLACE FUNCTION private.is_academic_record_credential_type(p_credential_type text)
-- ROLLBACK:     RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = private, public
-- ROLLBACK:   AS $$
-- ROLLBACK:     SELECT upper(COALESCE(p_credential_type, '')) IN ('DEGREE', 'CERTIFICATE', 'TRANSCRIPT');
-- ROLLBACK:   $$;
-- ROLLBACK: No data migration is involved — the predicate is IMMUTABLE and read-only,
-- ROLLBACK: and `get_public_anchor` is not modified by this migration.

CREATE OR REPLACE FUNCTION private.is_academic_record_credential_type(p_credential_type text)
  RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  SET search_path = private, public
AS $$
  -- SCRUM-3102: absent type (NULL, empty, or whitespace-only) FAILS CLOSED.
  -- This predicate answers "must this record suppress issuer-authored free
  -- text", NOT "is this one of the three academic types" — see COMMENT below.
  SELECT CASE
    WHEN p_credential_type IS NULL OR btrim(p_credential_type) = '' THEN true
    ELSE upper(btrim(p_credential_type)) IN ('DEGREE', 'CERTIFICATE', 'TRANSCRIPT')
  END;
$$;

COMMENT ON FUNCTION private.is_academic_record_credential_type(text) IS
  'SCRUM-3102 — SUPPRESSION predicate for the public anchor projection, not a '
  'taxonomy predicate. TRUE means "this record must not emit issuer- or '
  'extraction-authored free text". Returns TRUE for an ABSENT type (NULL, empty, '
  'whitespace) because an unclassifiable record cannot be shown to be safe: the '
  'academic set recognises SAFETY by enumeration, so unknown must fail closed. '
  'Returns TRUE for DEGREE/CERTIFICATE/TRANSCRIPT, FALSE for every other present '
  'enum value (credential_type is an enum column, so a non-empty value is always '
  'a known type, and blanking those would destroy real credential titles). '
  'The CTDL twin is suppressesRecordFreeText() in ctdl-pii-guard.ts.';

-- Re-assert the 0385 grants. CREATE OR REPLACE preserves the existing ACL, so
-- this is belt-and-braces: the predicate must never be callable by anon.
REVOKE ALL ON FUNCTION private.is_academic_record_credential_type(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.is_academic_record_credential_type(text) TO service_role;

-- PostgREST caches function signatures; reload so the projection picks the new
-- definition up immediately rather than at the next schema change.
NOTIFY pgrst, 'reload schema';
