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
--     DROP CONSTRAINT IF EXISTS anchor_proofs_completeness_class_check;  -- drops the VALIDATED (or NOT VALID) constraint either way
--   ALTER TABLE public.anchor_proofs
--     DROP COLUMN IF EXISTS proof_completeness_class;
--   NOTIFY pgrst, 'reload schema';

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Completeness-class column (additive, nullable) + CHECK.
--    Idempotent (IF NOT EXISTS / DROP-IF-EXISTS-then-ADD, the 0340 trigger
--    pattern) so a staging re-apply cannot wedge.
--
--    LOCK DISCIPLINE (why NOT VALID + a separate VALIDATE): a plain
--    `ADD CONSTRAINT ... CHECK (...)` takes ACCESS EXCLUSIVE on anchor_proofs
--    AND scans EVERY row to validate — even though the column is all-NULL and
--    every row passes, the validation still walks the whole heap while holding
--    the strongest lock, blocking the concurrent verify-API reads and the 0340
--    "SECURED ⇒ proof complete" trigger's per-anchor probe on the ~2.97M-row
--    prod table. So we split it: `ADD CONSTRAINT ... NOT VALID` records the
--    constraint against NEW/changed rows with only a brief ACCESS EXCLUSIVE
--    catalog touch (NO scan), then `VALIDATE CONSTRAINT` proves the existing
--    rows under SHARE UPDATE EXCLUSIVE — a lock that does NOT block SELECT,
--    INSERT, UPDATE, or DELETE. Both stay inside this transaction (VALIDATE is
--    transaction-safe; it is CREATE INDEX CONCURRENTLY that cannot be). The
--    end state is a fully-validated (not NOT VALID) constraint, identical to
--    the plain form but reached without the blocking full-lock scan.
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
  ) NOT VALID;

-- VALIDATE takes only SHARE UPDATE EXCLUSIVE (non-blocking to reads/writes and
-- to the 0340 trigger). Marks the constraint validated for the whole table.
ALTER TABLE public.anchor_proofs
  VALIDATE CONSTRAINT anchor_proofs_completeness_class_check;

COMMENT ON COLUMN public.anchor_proofs.proof_completeness_class IS
  'S3-A back-catalogue census class (PROOF-BACKCATALOG). NULL = not yet classified. direct_anchored = one tx / one anchor, OP_RETURN commits the fingerprint itself; empty Merkle-path fields are the HONEST state, never to be backfilled with a synthesized branch. batch_provable = root + batch membership on record, branch reconstructable by the self-validating SCRUM-2471 job. already_complete = 0340 predicate satisfied. ambiguous = contradictory/unprovable, blocks classifier write mode. A label asserts a CLASSIFICATION of existing evidence — it never asserts proof data that is not in this row.';

-- ---------------------------------------------------------------------------
-- 2. GUC reader RPC: the worker-side confirmation for the 0340 gate.
--    STABLE (reads a setting, no writes), SECURITY DEFINER + pinned
--    search_path (§1.4), service_role only — the enforcement state is an
--    internal operational fact, not tenant data.
--
--    WHY THE CATALOG, NOT current_setting(): the 0340 gate is flipped with
--    `ALTER DATABASE <db> SET arkova.proof_enforce_secured_complete = 'on'`,
--    which changes the setting only for NEW connections. `current_setting()`
--    reports the value THIS backend was started with — so a long-lived pooled
--    PgBouncer/PostgREST connection that predates the flip would keep reporting
--    'off' (or '') and the worker would wrongly believe enforcement is still
--    inert. Reading the DURABLE default straight out of pg_db_role_setting
--    reflects the ALTER DATABASE state regardless of the calling connection's
--    age, closing that stale-per-connection read.
--
--    pg_db_role_setting stores one row per (setdatabase, setrole) whose
--    `setconfig` is a text[] of 'name=value' entries. The 0340 gate is set with
--    `ALTER DATABASE ... SET`, which writes setrole = 0 (applies to ALL roles
--    in the database) — that is the AUTHORITATIVE, mechanism-matched row and is
--    what this reader consumes. (A per-role override is NOT the 0340 mechanism;
--    and because this function is SECURITY DEFINER, `current_user` here would be
--    the function OWNER, not the PostgREST caller role, so a role-scoped read
--    could not honestly resolve the caller's role anyway — we deliberately read
--    the database-wide default and stay mechanism-matched.) Custom namespaced
--    GUCs like arkova.* persist verbatim in this catalog. NULL (setting never
--    written durably) COALESCEs to '' → the worker maps '' / 'off' → off
--    (inert, the 0340 default), 'on' → on, anything else → unknown
--    (fail-closed).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_proof_enforcement_guc()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      -- Extract the value after 'arkova.proof_enforce_secured_complete=' from
      -- the durable database-wide (setrole = 0) setconfig array. This is the
      -- row `ALTER DATABASE ... SET` writes; it reflects the flip regardless of
      -- the calling backend's age. `NULLIF(split_part(...), '')` guards the
      -- (impossible-in-practice) empty-value case so it COALESCEs to '' too.
      SELECT NULLIF(split_part(cfg, '=', 2), '')
      FROM pg_db_role_setting drs
      CROSS JOIN LATERAL unnest(drs.setconfig) AS cfg
      WHERE drs.setdatabase = (
              SELECT oid FROM pg_database WHERE datname = current_database()
            )
        AND drs.setrole = 0
        AND cfg LIKE 'arkova.proof_enforce_secured_complete=%'
      LIMIT 1
    ),
    ''
  );
$$;

ALTER FUNCTION public.get_proof_enforcement_guc() OWNER TO postgres;

COMMENT ON FUNCTION public.get_proof_enforcement_guc() IS
  'S3-A(2): reads the DURABLE arkova.proof_enforce_secured_complete default from pg_db_role_setting (the 0340 "SECURED ⇒ proof complete" gate, flipped via ALTER DATABASE ... SET) so the worker can CONFIRM enforcement is off before classifier write mode — reflecting the ALTER DATABASE state regardless of the calling connection''s age (NOT current_setting(), which is stale on pooled pre-flip connections). Returns ''''/''off''/''on''. service_role only. Does not change the GUC.';

REVOKE ALL ON FUNCTION public.get_proof_enforcement_guc() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_proof_enforcement_guc() FROM anon;
REVOKE ALL ON FUNCTION public.get_proof_enforcement_guc() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_proof_enforcement_guc() TO service_role;

-- Reload PostgREST schema cache so the new column + RPC are visible.
NOTIFY pgrst, 'reload schema';

COMMIT;
