-- 0354_proof_completeness_class_and_guc_reader.sql
-- S3-A(2) (PROOF-BACKCATALOG, stacked on PR #1410) — the two schema gaps the
-- back-catalogue classifier reported honestly instead of working around:
--
--   1. `anchor_proofs.proof_completeness_class` — 0340 added completeness
--      DATA columns (block_header/block_hash/op_return_payload/merkle_index/
--      proof_schema_version) but no column that can carry the completeness
--      CLASS. Without it the honest census classes {direct_anchored |
--      batch_provable} cannot be persisted, and the 0340 trigger predicate
--      (merkle_root + proof_path) would forever reject honest DIRECT-anchored
--      rows whose empty Merkle-path fields ARE their truthful state (~2.97M
--      back-catalogue anchors: one tx per anchor, OP_RETURN commits the
--      fingerprint itself, no tree). The classifier's write mode refuses with
--      `schema_gap_0354` until this column exists.
--   2. `get_proof_enforcement_guc()` — PostgREST cannot read a GUC without a
--      SQL function, so the worker cannot CONFIRM the 0340 gate
--      `arkova.proof_enforce_secured_complete` is OFF before writing
--      (createDbGucReader returns 'unknown' → write mode fail-closes). This
--      reader RPC turns that fail-closed 'unknown' into a confirmed state.
--
-- WHAT THIS MIGRATION DOES NOT DO (deliberately):
--   - Does NOT touch the 0340 trigger or its predicate. Accepting
--     `proof_completeness_class = 'direct_anchored'` as an alternative
--     completeness proof is a SEPARATE, later decision (trigger amendment
--     wave), taken only after the census + labeling have run on prod.
--   - Does NOT flip the GUC. `arkova.proof_enforce_secured_complete` stays
--     OFF (unset); this migration only makes its state READABLE.
--   - Does NOT backfill any label. Labeling is the classifier's write mode:
--     operator-triggered, quadruple-gated, halt-on-ambiguous, Carson-gated
--     on prod.
--
-- INDEX DECISION (none added — justified): the only hot read path touching
-- anchor_proofs is per-anchor lookup, already served by the UNIQUE
-- constraint on anchor_id (anchor_proofs_anchor_unique). The class column is
-- read by (a) that same per-anchor path and (b) rare operator census/audit
-- queries. A partial index per class would add write amplification to the
-- multi-million-row labeling backfill for no serving read path. If a
-- class-filtered read path materializes later (e.g. "re-check every
-- batch_provable row"), add it then as an operator-run
-- CREATE INDEX CONCURRENTLY per the 0330 convention (non-transactional).
--
-- NOTE: the column is additive + nullable (NULL = not yet classified), so
-- this does not rewrite existing rows and the verify API (§1.8 frozen
-- schema) stays additive. The CHECK values are EXACTLY the classifier's
-- BackCatalogClass strings (services/worker/src/jobs/
-- proof-backcatalog-classifier.ts) — the worker and the constraint cannot
-- drift without one of them failing loudly.
--
-- ROLLBACK:
--   REVOKE ALL ON FUNCTION public.get_proof_enforcement_guc() FROM service_role;
--   DROP FUNCTION IF EXISTS public.get_proof_enforcement_guc();
--   ALTER TABLE public.anchor_proofs
--     DROP CONSTRAINT IF EXISTS anchor_proofs_completeness_class_check;
--   ALTER TABLE public.anchor_proofs
--     DROP COLUMN IF EXISTS proof_completeness_class;
--   NOTIFY pgrst, 'reload schema';

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Completeness-class column (additive, nullable) + CHECK.
--    Idempotent (IF NOT EXISTS / DROP-IF-EXISTS-then-ADD, the 0340 trigger
--    pattern) so a staging re-apply cannot wedge. The CHECK validation scan
--    runs over a freshly added all-NULL column (every row passes trivially),
--    inside the same transaction's lock.
-- ---------------------------------------------------------------------------
ALTER TABLE public.anchor_proofs
  ADD COLUMN IF NOT EXISTS proof_completeness_class text;

ALTER TABLE public.anchor_proofs
  DROP CONSTRAINT IF EXISTS anchor_proofs_completeness_class_check;

ALTER TABLE public.anchor_proofs
  ADD CONSTRAINT anchor_proofs_completeness_class_check CHECK (
    proof_completeness_class IS NULL
    OR proof_completeness_class IN (
      'direct_anchored',
      'batch_provable',
      'already_complete',
      'ambiguous'
    )
  );

COMMENT ON COLUMN public.anchor_proofs.proof_completeness_class IS
  'S3-A back-catalogue census class (PROOF-BACKCATALOG). NULL = not yet classified. direct_anchored = one tx / one anchor, OP_RETURN commits the fingerprint itself; empty Merkle-path fields are the HONEST state, never to be backfilled with a synthesized branch. batch_provable = root + batch membership on record, branch reconstructable by the self-validating SCRUM-2471 job. already_complete = 0340 predicate satisfied. ambiguous = contradictory/unprovable, blocks classifier write mode. A label asserts a CLASSIFICATION of existing evidence — it never asserts proof data that is not in this row.';

-- ---------------------------------------------------------------------------
-- 2. GUC reader RPC: the worker-side confirmation for the 0340 gate.
--    STABLE (reads a setting, no writes), SECURITY DEFINER + pinned
--    search_path (§1.4), service_role only — the enforcement state is an
--    internal operational fact, not tenant data.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_proof_enforcement_guc()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- current_setting(..., true) returns NULL when the GUC was never set;
  -- COALESCE to '' so callers always receive text. The worker maps
  -- '' / 'off' → off (inert, the 0340 default) and 'on' → on; anything
  -- else → unknown (fail-closed).
  SELECT COALESCE(current_setting('arkova.proof_enforce_secured_complete', true), '');
$$;

ALTER FUNCTION public.get_proof_enforcement_guc() OWNER TO postgres;

COMMENT ON FUNCTION public.get_proof_enforcement_guc() IS
  'S3-A(2): reads arkova.proof_enforce_secured_complete (the 0340 "SECURED ⇒ proof complete" gate) so the worker can CONFIRM enforcement is off before classifier write mode. Returns ''''/''off''/''on''. service_role only. Does not change the GUC.';

REVOKE ALL ON FUNCTION public.get_proof_enforcement_guc() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_proof_enforcement_guc() FROM anon;
REVOKE ALL ON FUNCTION public.get_proof_enforcement_guc() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_proof_enforcement_guc() TO service_role;

-- Reload PostgREST schema cache so the new column + RPC are visible.
NOTIFY pgrst, 'reload schema';

COMMIT;
