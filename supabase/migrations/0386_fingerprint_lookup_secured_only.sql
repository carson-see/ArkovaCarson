BEGIN;

-- =============================================================================
-- 0386 — get_public_anchor_by_fingerprint: close the fingerprint EXISTENCE
--        ORACLE by restoring 0339's `status = 'SECURED'` invariant.
--
-- ── WHICH DEFINITION THIS IS BASED ON (read this before writing an 0387) ─────
--
--   BASE: the LIVE PRODUCTION definition of
--   public.get_public_anchor_by_fingerprint as of 2026-08-02, captured via
--       SELECT pg_get_functiondef(oid), md5(prosrc) FROM pg_proc
--        WHERE proname = 'get_public_anchor_by_fingerprint';
--   on project `vzwyaatejekddvltxyye`. Source body md5:
--   `1fd78aece7613fd191f7a053f2f66475`.
--
--   NOT based on the 0339 file, even though this migration restores 0339's
--   RULE. Branching a function body from a stale migration file is exactly what
--   0376 did to this function's sibling: it was written from the 0355 file
--   instead of the then-current head, silently reverted 0356's keyed HMAC and
--   0362's allow-list, and left an unsalted, dictionary-reversible SHA-256 of
--   recipient e-mail addresses on an anon-callable endpoint for four days.
--   Restoring an intent is not a licence to restore an old body: everything
--   below except the two named changes is byte-for-byte the current prod body.
--
-- ── THE DEFECT: PROD SILENTLY DRIFTED FROM ITS OWN MIGRATION ────────────────
--
--   `0339_get_public_anchor_by_fingerprint.sql` restricts the lookup to
--   `a.status = 'SECURED'` and states the reason in its header, verbatim:
--
--       "Public-id verification can show known in-flight anchors, but
--        fingerprint lookup must not become a global existence oracle for
--        pending/submitted content hashes."
--
--   Production instead runs `a.status IN ('SECURED','SUBMITTED','PENDING')`.
--   No migration on main redefines this function after 0339, so the running
--   body has NO SOURCE IN THE REPOSITORY and nothing recorded the drift.
--
--   MEASURED EXPOSURE (prod, 2026-08-02, read-only): **3 PENDING + 48,149
--   SUBMITTED** non-deleted anchors are currently confirmable by an
--   ANONYMOUS caller. `get_public_anchor_by_fingerprint` is GRANTed to `anon`
--   (0339) and reachable unauthenticated over PostgREST, so anyone holding or
--   guessing a document's SHA-256 can today confirm that the document exists
--   in Arkova BEFORE it is anchored — including documents whose owners have
--   published nothing. That is a pre-publication existence oracle over content
--   hashes: it discloses that a specific known file was submitted, and by whom
--   it was submitted it does not say, but the mere existence answer is the
--   disclosure 0339 was written to prevent.
--
--   Fingerprints are not secrets in the threat model — a counterparty who was
--   sent the document can compute one — which is precisely why the answer to
--   "does Arkova hold this?" must be limited to records their owner has
--   already made public by securing them.
--
-- ── WHAT CHANGES (exactly two things) ───────────────────────────────────────
--
--   1. `AND a.status IN ('SECURED','SUBMITTED','PENDING')`
--        becomes
--      `AND a.status = 'SECURED'`
--      — restoring 0339. In-flight records return the same
--      `{"error":"Record not found"}` envelope an unknown fingerprint returns,
--      so the response is indistinguishable from "we hold nothing" and leaks
--      nothing by timing or shape.
--
--   2. `ORDER BY a.created_at DESC`
--        becomes
--      `ORDER BY a.created_at DESC, a.id DESC`
--      — also restoring 0339. This is a SEPARATE, deliberately-named change,
--      not a smuggled one: `created_at` is not unique, and two anchors sharing
--      a timestamp currently resolve to a NON-DETERMINISTIC winner, so the same
--      fingerprint can return different public_ids across calls on a
--      verification endpoint. It has no behavioural downside and is one clause;
--      if a reviewer wants it out, it can be dropped without touching change 1.
--
--   Everything else — the null/blank guard, the lowercase-input comparison that
--   keeps `idx_anchors_fingerprint_lookup` usable, the `deleted_at` guard, the
--   delegation to `get_public_anchor` as the single source of redaction truth,
--   `STABLE SECURITY DEFINER`, `SET search_path TO 'public'`, the return type,
--   and the grants — is unchanged.
--
-- ── BLAST RADIUS: WHO CALLS THIS ───────────────────────────────────────────
--
--   There is NO frontend caller. A repo-wide grep of `src/`, `services/`,
--   `e2e/` and `scripts/` finds this RPC referenced only by
--   `services/edge/src/mcp-tools.ts` and by generated `database.types.ts`. The
--   public verify page and the embeddable widget call
--   `get_public_anchor(public_id)`, whose status set this migration does not
--   touch — they still surface PENDING/SUBMITTED for a record looked up by its
--   own public id, which is the disclosure the owner opted into.
--
--   The one real caller already treats the tightened result as its documented
--   happy path. `handleVerifyDocument` maps `{"error":"Record not found"}` to a
--   `verified:false / status:'UNKNOWN'` envelope, and its own doc comment reads
--   "An unknown or NOT-YET-SECURED fingerprint is NOT an error."
--
--   `services/edge/src/mcp-tools.test.ts` ALREADY ASSERTS this behaviour
--   ("PENDING fingerprint filtered by RPC → UNKNOWN, not an existence leak",
--   and the SUBMITTED twin). Those tests pass in CI because they MOCK the RPC
--   response — so the suite has been asserting an invariant production
--   violates. `tests/rls/fingerprint-lookup-secured-only.test.ts` is added in
--   the same change to exercise the REAL function, so the invariant is pinned
--   against the running system and not against a fixture.
--
-- ── ENVELOPE ───────────────────────────────────────────────────────────────
--
--   SECURITY DEFINER + SET search_path = public preserved (CLAUDE.md §1.4).
--   Grants unchanged — this stays a deliberately public verification endpoint
--   (`anon`, `authenticated`), and 0364's test explicitly pins that it must
--   remain anon-callable. §1.8: no field added, renamed, removed, or made
--   non-nullable; the response SHAPE is identical, only which rows resolve
--   changes. §1.13 R-7: no external-status claim added or changed.
--
--   TIER: T3 (supabase/migrations/ + a security-sensitive anon-GRANTed
--   projection). Prod-apply is RTE/CTO-owned — NOT applied by this session.
--
--   BEHAVIOUR CHANGE, stated plainly: any undocumented external consumer that
--   relied on resolving a fingerprint BEFORE the record was secured will now
--   receive "Record not found" until securing completes. That is the intended
--   0339 contract and how the only in-repo caller already renders it.
--
-- ROLLBACK:
--   Re-apply the pre-0386 production body (source md5
--   `1fd78aece7613fd191f7a053f2f66475`) — i.e. this exact function definition
--   with the two changes reverted:
--       AND a.status IN ('SECURED', 'SUBMITTED', 'PENDING')
--       ORDER BY a.created_at DESC
--   then `NOTIFY pgrst, 'reload schema';`. No schema change, no data
--   migration, no flag. Reverting restores the existence oracle.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_public_anchor_by_fingerprint(p_fingerprint text)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_public_id text;
BEGIN
  IF p_fingerprint IS NULL OR length(trim(p_fingerprint)) = 0 THEN
    RETURN jsonb_build_object('error', 'Record not found');
  END IF;

  -- Resolve the latest non-deleted SECURED anchor for this fingerprint.
  --
  -- 0386: SECURED ONLY, restoring 0339. Public-id verification can surface a
  -- known in-flight anchor because the caller already holds that record's
  -- public id; a FINGERPRINT is not such a capability — a counterparty who was
  -- merely sent the document can compute one — so answering for PENDING or
  -- SUBMITTED rows turns this into a global existence oracle over content
  -- hashes. An in-flight record therefore returns the SAME
  -- `{"error":"Record not found"}` envelope as a fingerprint we have never
  -- seen, so the two are indistinguishable to the caller.
  --
  -- Fingerprints are stored lowercase (the worker writes them via
  -- `.eq('fingerprint', fp.toLowerCase())`), so lowercase only the INPUT and
  -- compare against the bare column. A column-side `lower(a.fingerprint)`
  -- would defeat idx_anchors_fingerprint_lookup (a plain btree on
  -- `fingerprint`); `a.fingerprint = lower(p_fingerprint)` lets it be used.
  --
  -- 0386: `a.id DESC` restores 0339's deterministic tiebreak. `created_at` is
  -- not unique, so ordering by it alone lets two anchors sharing a timestamp
  -- resolve to a non-deterministic winner across calls.
  SELECT a.public_id
    INTO v_public_id
  FROM anchors a
  WHERE a.fingerprint = lower(p_fingerprint)
    AND a.status = 'SECURED'
    AND a.deleted_at IS NULL
  ORDER BY a.created_at DESC, a.id DESC
  LIMIT 1;

  IF v_public_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Record not found');
  END IF;

  -- Single source of redaction truth: reuse the public_id-keyed projection.
  RETURN public.get_public_anchor(v_public_id);
END;
$$;

COMMENT ON FUNCTION public.get_public_anchor_by_fingerprint(text)
  IS 'Fingerprint-keyed sibling of get_public_anchor. Lowercases input and '
     'returns the latest non-deleted SECURED anchor in the SAME redacted jsonb '
     'shape (delegates the projection to get_public_anchor so redaction stays '
     'in one place). SECURED-ONLY is a security invariant, not an oversight '
     '(0339, restored by 0386): a fingerprint is not a capability, so resolving '
     'PENDING/SUBMITTED rows would make this a global existence oracle over '
     'content hashes. In-flight and unknown fingerprints both return '
     '{"error":"Record not found"} and are indistinguishable.';

NOTIFY pgrst, 'reload schema';

COMMIT;
