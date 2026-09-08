BEGIN;

-- A bounded lock_timeout for the whole transaction (CLAUDE.md §1.2). Stated
-- honestly: this migration issues NO DDL against `anchors` — it only replaces a
-- function body — so there is no hot-table barrier for this guard to prevent.
-- It is here because `CREATE OR REPLACE FUNCTION` still takes locks in the
-- catalog and the trailing `NOTIFY pgrst` drives a PostgREST introspection, and
-- a bounded default costs one line. Do not read this line as evidence that
-- hot-table DDL was reviewed and found safe; there is none.
SET LOCAL lock_timeout = '5s';

-- =============================================================================
-- 0441 — get_public_anchor_by_fingerprint: cast the PARAMETER to bpchar so
--        idx_anchors_fingerprint_lookup is usable again.
--
--        Verify-by-fingerprint currently TIMES OUT in production. This is a
--        one-clause fix to a live, user-visible outage of that feature.
--
-- ── WHICH DEFINITION THIS IS BASED ON (read this before writing an 0442) ─────
--
--   BASE: migration `0386_fingerprint_lookup_secured_only.sql`, which is the
--   body running in production. 0386 was applied to prod on 2026-08-02/03 and
--   verified live via `pg_get_functiondef` at apply time (HANDOFF.md, "Migrations
--   applied to prod and reconciled today (2026-08-02/03): 0382 … 0392"). Unlike
--   0386 — which had to be written from `pg_get_functiondef` because prod had
--   silently drifted off `main` with no source in the repository — the file and
--   the running body agree here, so the file is a legitimate base.
--
--   Everything below except the ONE named change is byte-for-byte 0386's body:
--   the null/blank guard, the SECURED-only filter, the `deleted_at` guard, the
--   `ORDER BY a.created_at DESC, a.id DESC` tiebreak, the `LIMIT 1`, the
--   delegation to `get_public_anchor` as the single source of redaction truth,
--   the `{"error":"Record not found"}` envelope for BOTH the not-found and the
--   in-flight case, `STABLE SECURITY DEFINER`, `SET search_path TO 'public'`,
--   the return type, and the grants.
--
-- ── THE DEFECT: A TYPE MISMATCH MAKES THE INDEX UNUSABLE ────────────────────
--
--   Found in production on 2026-09-08 during the SCRUM-3797 edge catch-up
--   deploy (`docs/staging/edge-retro-2026-09-07/DEPLOY.md`, finding 1). The MCP
--   tools `verify` (by fingerprint) and `get_fingerprint` on
--   https://edge.arkova.ai both return
--   `isError: "Document verification timed out"`.
--
--   `anchors.fingerprint` is `character(64)` (bpchar). `p_fingerprint` is
--   `text`. 0386 compares them directly:
--
--       WHERE a.fingerprint = lower(p_fingerprint)          -- bpchar = text
--
--   There is no `bpchar = text` operator. Postgres resolves the comparison by
--   casting the **COLUMN** to text, which is the one side that must stay
--   untouched: `idx_anchors_fingerprint_lookup` is a btree on the bare bpchar
--   column (`ON anchors (fingerprint) WHERE deleted_at IS NULL`), and an
--   expression the index was not built on cannot drive it. Proven against prod
--   `vzwyaatejekddvltxyye`, where the plan reads:
--
--       Filter: ((fingerprint)::text = '…'::text)
--
--   With the fingerprint predicate demoted from an Index Cond to a Filter, the
--   planner has nothing selective left and falls back to
--   `idx_anchors_status_secured_submitted`, scanning the ~3.5M-row SECURED
--   partition at **cost 2,302,395** — past `statement_timeout`. So the RPC does
--   not return slowly; it does not return at all.
--
--   0386 and 0339 both carry a comment asserting the opposite — that lowercasing
--   only the INPUT "lets it be used". That reasoning is right about the half it
--   considered (a column-side `lower(a.fingerprint)` would indeed defeat the
--   index) and silently wrong about the implicit cast the cross-type comparison
--   inserts on that same side. The corrected comment is in the body below; the
--   claim is not left standing anywhere in this file.
--
-- ── WHAT CHANGES (exactly one thing) ────────────────────────────────────────
--
--       WHERE a.fingerprint = lower(p_fingerprint)
--         becomes
--       WHERE a.fingerprint = lower(p_fingerprint)::bpchar
--
--   Cast the PARAMETER, never the column. This is the identical mechanism and
--   the identical remedy as migration `0370` (SCRUM-3031), where the same
--   bpchar/text mismatch on this same column turned `batch_insert_anchors` into
--   a full `Seq Scan` + disk sort and wedged the anchoring pipeline. 0370's
--   rule, restated: cast explicitly ONLY on the non-indexed side.
--
--   MEASURED, on a local Postgres 17.9 repro built to prod's index shapes
--   (300,000 SECURED rows; both `idx_anchors_fingerprint_lookup` and
--   `idx_anchors_status_secured_submitted` present; `EXPLAIN ANALYZE`):
--
--     BEFORE: Index Scan using idx_anchors_active_created
--               Filter: ((fingerprint)::text = '…'::text)
--               Rows Removed by Filter: 299,999
--             Execution Time: 100.284 ms          (at 1/12th of prod's size)
--     AFTER:  Index Scan using idx_anchors_fingerprint_lookup
--               Index Cond: (fingerprint = '…'::bpchar)
--             Execution Time: 0.343 ms
--
--   The before-cost is O(N) in the table, so it widens at prod's ~3.5M rows —
--   which is why prod times out where a 300k repro merely crawls. Prod's own
--   `EXPLAIN (ANALYZE)` with this cast: `Index Scan using
--   idx_anchors_fingerprint_lookup`, **3.020 ms**.
--
--   TRUNCATION IS NOT REACHABLE HERE, and that is worth stating because it is
--   exactly what adversarial review caught in 0370's first cut: an EXPLICIT
--   cast to `character(64)` silently TRUNCATES an overlong input rather than
--   raising. In 0370 that mattered — the value was on its way INTO the column
--   as a dedup key. Here the cast is on a READ predicate only. A >64-char input
--   truncates to 64 characters and then either matches a real fingerprint (the
--   caller already holds the full 64-hex prefix, so it learns nothing it did not
--   supply) or matches nothing. It cannot write, corrupt, or collide a stored
--   row, and `anchors_fingerprint_format` still constrains every stored value to
--   exactly 64 hex characters. No pre-validation is added, so this migration
--   changes exactly one thing.
--
-- ── WHAT DOES NOT CHANGE ────────────────────────────────────────────────────
--
--   0386's security invariant is untouched: SECURED-only, so a fingerprint is
--   still not an existence oracle over PENDING/SUBMITTED content hashes, and an
--   in-flight record still returns the SAME `{"error":"Record not found"}`
--   envelope an unknown fingerprint returns. §1.8: no field added, renamed,
--   removed, or made non-nullable — the response SHAPE and the set of rows that
--   resolve are both identical. This migration changes only HOW the planner
--   reaches the same row. §1.4: SECURITY DEFINER + `SET search_path = public`
--   preserved. Grants unchanged — this stays a deliberately anon-callable public
--   verification endpoint, which 0364's test pins.
--
--   No behaviour change is intended or expected for any caller. The one in-repo
--   caller is `services/edge/src/mcp-tools.ts` (`handleVerifyDocument` /
--   `get_fingerprint`); it currently receives a timeout and will now receive the
--   answer it was always supposed to get.
--
-- ── WHY THE SOAK DID NOT CATCH IT, AND THE RATCHET THAT WILL ────────────────
--
--   The 12h retro-soak rig fixture is 10 rows, where a sequential scan is
--   instant — a plan defect is invisible to a timing assertion at that size.
--   `tests/rls/fingerprint-lookup-index-plan.test.ts` is added in this same
--   change and pins the PLAN instead of the clock: with `enable_seqscan = off`
--   it asserts the live function's own predicate reaches
--   `idx_anchors_fingerprint_lookup` by **Index Cond**, which is true or false
--   at ANY table size. It carries the pre-0441 predicate as a negative control,
--   so the test proves it would have failed before this migration.
--
--   TIER: T3 (supabase/migrations/). Prod-apply is RTE/CTO-owned — NOT applied
--   by this session.
--
-- ROLLBACK:
--   Re-apply migration `0386_fingerprint_lookup_secured_only.sql` verbatim —
--   i.e. this exact function definition with the single cast reverted:
--       WHERE a.fingerprint = lower(p_fingerprint)
--   then `NOTIFY pgrst, 'reload schema';`. No schema change, no data migration,
--   no flag, no grant change. Reverting restores the production timeout on
--   verify-by-fingerprint.
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
  -- 0441: BOTH SIDES OF THIS COMPARISON MUST BE bpchar. `anchors.fingerprint`
  -- is `character(64)`; `p_fingerprint` is `text`. Fingerprints are stored
  -- lowercase (the worker writes them via `.eq('fingerprint', fp.toLowerCase())`),
  -- so the input still gets lowercased — but `lower()` returns text, and there
  -- is no `bpchar = text` operator, so Postgres resolved the comparison by
  -- casting the COLUMN to text. `idx_anchors_fingerprint_lookup` is a btree on
  -- the bare bpchar column, so `(fingerprint)::text = …` demoted the predicate
  -- from an Index Cond to a Filter and the planner scanned the ~3.5M-row SECURED
  -- partition instead — past statement_timeout, which is how verify-by-
  -- fingerprint came to fail closed in production on 2026-09-08.
  --
  -- The `::bpchar` therefore goes on the PARAMETER, never on the column: cast
  -- the indexed side and the index is unusable again, which is the whole defect.
  -- Same mechanism, same remedy as migration 0370 on this same column.
  --
  -- 0386: `a.id DESC` restores 0339's deterministic tiebreak. `created_at` is
  -- not unique, so ordering by it alone lets two anchors sharing a timestamp
  -- resolve to a non-deterministic winner across calls.
  SELECT a.public_id
    INTO v_public_id
  FROM anchors a
  WHERE a.fingerprint = lower(p_fingerprint)::bpchar
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
  IS 'Fingerprint-keyed sibling of get_public_anchor. Lowercases input, casts it '
     'to bpchar, and returns the latest non-deleted SECURED anchor in the SAME '
     'redacted jsonb shape (delegates the projection to get_public_anchor so '
     'redaction stays in one place). SECURED-ONLY is a security invariant, not an '
     'oversight (0339, restored by 0386): a fingerprint is not a capability, so '
     'resolving PENDING/SUBMITTED rows would make this a global existence oracle '
     'over content hashes. In-flight and unknown fingerprints both return '
     '{"error":"Record not found"} and are indistinguishable. The ::bpchar cast '
     'on the PARAMETER is load-bearing (0441): anchors.fingerprint is '
     'character(64), so comparing it to a bare text value makes Postgres cast the '
     'COLUMN and idx_anchors_fingerprint_lookup unusable — that cost this endpoint '
     'a statement_timeout against the ~3.5M-row SECURED partition in production. '
     'Never move the cast to the column side.';

NOTIFY pgrst, 'reload schema';

COMMIT;
