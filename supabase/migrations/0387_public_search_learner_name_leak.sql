BEGIN;

-- =============================================================================
-- 0387 — search_public_credentials: stop publishing learner names through the
--        PUBLIC SEARCH surface, on BOTH the projection and the MATCH side.
--
-- ── WHICH DEFINITION THIS IS BASED ON (read this before writing an 0388) ─────
--
--   BASE: the LIVE PRODUCTION definition of public.search_public_credentials
--   as of 2026-08-02, captured via
--       SELECT pg_get_functiondef(oid), md5(prosrc) FROM pg_proc
--        WHERE proname = 'search_public_credentials';
--   on project `vzwyaatejekddvltxyye`. Source body md5:
--   `411787e41120fda83c3aef4511b00da9`.
--
--   NOT based on `0325_public_search_min_length_and_timeouts.sql`. Branching a
--   function body from a stale migration file is what made 0376 revert 0356's
--   keyed HMAC and 0362's allow-list and leave reversible recipient-email
--   hashes on an anon endpoint for four days.
--
-- ── THE DEFECT: 0385 CLOSED ONE DOOR, THIS IS THE OTHER ─────────────────────
--
--   0385 removed the raw `filename` from `get_public_anchor`, because the verify
--   page renders it as the record's display title and embeds it in schema.org
--   JSON-LD. `search_public_credentials` is a DIFFERENT anon-executable
--   function over the SAME rows, and it still projected
--       'title', a.filename
--   verbatim. Verified live against prod, unauthenticated:
--
--       SELECT * FROM public.search_public_credentials('ava-williams', 3);
--       -> { "title": "diploma-ava-williams.pdf", "credential_type": "DEGREE",
--            "status": "SECURED", "public_id": "ARK-ACD-WQC5PX", ... }
--
--   Probes for `isabella`, `taylor`, `sofia` each returned hits. This powers
--   the public search surface (search.arkova.ai), so it is the most
--   index-adjacent of the three public paths. `anon` and `authenticated` both
--   hold EXECUTE.
--
-- ── WHY SUPPRESSING THE TITLE ALONE WOULD NOT HAVE FIXED IT ─────────────────
--
--   THIS IS THE SUBTLE HALF. DO NOT "SIMPLIFY" IT AWAY.
--
--   Blanking the returned `title` while leaving `filename` in the ILIKE
--   predicate converts a disclosure into an ORACLE: an attacker searches
--   "ava-williams", gets a non-empty result set, and has confirmed the learner's
--   name is attached to a DEGREE — from the HIT COUNT alone, without ever
--   reading a title. The searchable surface is part of the disclosure surface.
--
--   So this migration changes BOTH sides, and the invariant it establishes is:
--
--       **You can only search for text we would be willing to show you.**
--
--   Every predicate matches the SAME value the projection would emit. A value
--   the gate drops is unmatchable as well as unprintable, so no query can
--   distinguish "we hold this and are hiding it" from "we hold nothing".
--
-- ── WHAT CHANGES (four things) ─────────────────────────────────────────────
--
--   1. PROJECTION. `'title', a.filename` becomes, exactly as 0385 does it:
--        academic record  -> private.academic_record_public_label(credential_type)
--        everything else  -> private.public_free_text_or_null(a.filename),
--                            falling back to the controlled label so `title` is
--                            NEVER NULL (the search UI renders it as the result
--                            heading).
--
--   2. MATCH SIDE, academic records. `DEGREE`/`CERTIFICATE`/`TRANSCRIPT` are
--      excluded from matching outright. Their only searchable fields are
--      `filename` and `description`, both of which are learner-authored free
--      text, so there is nothing left to match on — an academic record is not a
--      publicly searchable object. This is the clause that closes the hit-count
--      oracle.
--
--   3. MATCH SIDE, everything else. A non-academic row matches only if the
--      cleaned value is non-null, i.e. only on text we would print. Written as
--      `cheap ILIKE AND gate(...) IS NOT NULL` per branch so the planner
--      evaluates the ILIKE first and the gate runs only on already-matched
--      rows — the function never touches the full table. Without this, a
--      filename like `signed-by-jane.doe@example.com.pdf` would still be
--      confirmable by searching the address even though 0385 stops us printing
--      it.
--
--   4. STATUS. `IN ('SECURED','SUBMITTED')` becomes `= 'SECURED'`. Matching
--      SUBMITTED is the same pre-publication disclosure class 0386 closed on the
--      fingerprint RPC, and it is strictly worse here: the fingerprint oracle
--      leaked existence, this leaked the FILENAME of a document whose owner had
--      published nothing.
--
--   Everything else is byte-for-byte the current prod body: the ≥3-character
--   minimum, the 1..50 limit clamp, the `public_org_ids` MATERIALIZED CTE and
--   the `org_id IS NULL OR public org` visibility rule (individual users stay
--   publicly searchable — that is the product), `ORDER BY a.created_at DESC`,
--   `RETURNS SETOF jsonb`, `STABLE SECURITY DEFINER`, `SET search_path`, and
--   `SET statement_timeout = '5s'`.
--
-- ── THE PRODUCT MUST SURVIVE ───────────────────────────────────────────────
--
--   A fix that empties public search is not a fix. Non-academic public records —
--   the ACRA / USPTO / EDGAR corpus that `diploma` and similar queries surface
--   today — remain findable: they are not academic types, their filenames carry
--   no format-anchored PII, so both the gate and the exclusion pass them
--   through unchanged. `tests/rls/public-search-learner-name-leak.test.ts`
--   pins this with a positive control, and the verification query below carries
--   a non-vacuity column for the same reason.
--
-- ── DEPENDENCY ─────────────────────────────────────────────────────────────
--
--   Requires the `private.*` helpers created by
--   `0385_public_anchor_academic_record_pii_projection.sql` (already applied to
--   prod; source on PR #1841, which this branch is stacked on). No new helper
--   logic is introduced here — deliberately: one detector, one academic-type
--   set, one controlled-label vocabulary, enforced by
--   `scripts/ci/public-pii-projection-contract.json`.
--
-- ── ENVELOPE ───────────────────────────────────────────────────────────────
--
--   SECURITY DEFINER + SET search_path preserved (CLAUDE.md §1.4). Grants
--   unchanged — this stays deliberately anon-executable. §1.8: the returned
--   jsonb keys are identical; only values narrow and fewer rows match. §1.13
--   R-7: no external-status claim added or changed.
--
--   TIER: T3 (supabase/migrations/ + a security-sensitive anon-executable
--   surface). Prod-apply is RTE/CTO-owned — NOT applied by this session.
--
-- ROLLBACK:
--   Re-apply the pre-0387 production body (source md5
--   `411787e41120fda83c3aef4511b00da9`) — this exact definition with:
--       'title', a.filename
--       AND a.status IN ('SECURED', 'SUBMITTED')
--       AND (a.filename ILIKE v_pattern OR a.description ILIKE v_pattern)
--   and the academic-exclusion clause removed. Then
--   `NOTIFY pgrst, 'reload schema';`. No schema change, no data migration, no
--   flag. Reverting republishes learner names on the public search surface.
-- =============================================================================

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
     'on text the projection would print, and is restricted to SECURED. The '
     'match-side rules are load-bearing, not redundant with the projection: '
     'suppressing only the returned title would still let a caller confirm a '
     'learner name from a non-empty result set.';

NOTIFY pgrst, 'reload schema';

COMMIT;
