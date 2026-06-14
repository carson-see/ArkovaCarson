-- ============================================================================
-- JIRA: SCRUM-2193 — Validate anchors CPE/CLE metadata CHECK constraints
-- ============================================================================
-- PURPOSE
--   Bring PROD into agreement with the repo by marking two CHECK constraints
--   on public.anchors as VALIDATED:
--     * anchors_cpe_metadata_is_object
--     * anchors_cle_metadata_is_object
--
--   Predicates (verbatim from 0315_professional_education_foundations.sql):
--     anchors_cpe_metadata_is_object:
--       CHECK (cpe_metadata IS NULL OR jsonb_typeof(cpe_metadata) = 'object')
--     anchors_cle_metadata_is_object:
--       CHECK (cle_metadata IS NULL OR jsonb_typeof(cle_metadata) = 'object')
--
-- REPO ↔ PROD DRIFT
--   Migration 0315 declares both constraints inline (ADD CONSTRAINT ... CHECK),
--   which on a clean apply creates them already VALID. In PROD, however, both
--   constraints currently report pg_constraint.convalidated = false (NOT VALID).
--   That means rows written BEFORE 0315 landed were never verified against the
--   predicate — PostgreSQL only enforces a NOT VALID CHECK on subsequent
--   INSERT/UPDATE, never retroactively. This migration runs the deferred
--   VALIDATE CONSTRAINT scan to close that gap and remove the repo↔prod drift.
--
-- WHY A FORWARD MIGRATION (not a manual psql one-off)
--   The drift must be reproducible and gated through the normal pipeline
--   (migration → PR → T3 soak → human apply), not an out-of-band psql change
--   that would itself create a new ledger/runtime divergence.
--
-- ---------------------------------------------------------------------------
-- PRE-CHECK (must be 0 violating rows before validating)
-- ---------------------------------------------------------------------------
--   VALIDATE CONSTRAINT will itself fail loudly if any row violates the
--   predicate, so this migration is self-protecting: a violation aborts the
--   transaction and nothing is marked valid. Before scheduling the human apply,
--   operators should independently confirm zero violators. anchors is ~3M rows
--   / ~22 GB in prod, so a full COUNT(*) over the table times out at the
--   default statement_timeout. Use a BUDGETED / SAMPLED probe instead, e.g.:
--
--     -- budgeted probe (cap the scan; expect 0 rows back)
--     SET statement_timeout = '60s';
--     SELECT id
--       FROM public.anchors
--      WHERE (cpe_metadata IS NOT NULL AND jsonb_typeof(cpe_metadata) <> 'object')
--         OR (cle_metadata IS NOT NULL AND jsonb_typeof(cle_metadata) <> 'object')
--      LIMIT 1;
--
--     -- or a sampled scan if even the budgeted probe is too heavy:
--     SELECT id
--       FROM public.anchors TABLESAMPLE SYSTEM (1)
--      WHERE (cpe_metadata IS NOT NULL AND jsonb_typeof(cpe_metadata) <> 'object')
--         OR (cle_metadata IS NOT NULL AND jsonb_typeof(cle_metadata) <> 'object')
--      LIMIT 1;
--
--   Any returned row means a violator exists — STOP and remediate the data
--   before running this migration.
--
-- LOCKING / ONLINE SAFETY
--   VALIDATE CONSTRAINT takes only SHARE UPDATE EXCLUSIVE on public.anchors. It
--   does NOT block concurrent reads or writes; it scans the table once to prove
--   every existing row satisfies the predicate, then flips convalidated = true.
--   statement_timeout is disabled below because the full-table scan over ~3M
--   rows / ~22 GB exceeds the default budget.
-- ============================================================================

BEGIN;

-- Allow the full-table validation scan to run to completion on the ~22 GB
-- prod anchors table. LOCAL = reverts at COMMIT/ROLLBACK; scoped to this txn.
SET LOCAL statement_timeout = 0;

-- Idempotent + clean-DB-safe: only validate if the constraint exists AND is
-- still NOT VALID. On a fresh DB 0315 already creates these VALID, so each
-- guard is a no-op there (expected). The two ALTERs are separate statements so
-- a failure on one is unambiguous.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t      ON t.oid = c.conrelid
      JOIN pg_namespace n  ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'anchors'
       AND c.conname = 'anchors_cpe_metadata_is_object'
       AND c.contype = 'c'
       AND c.convalidated = false
  ) THEN
    ALTER TABLE public.anchors VALIDATE CONSTRAINT anchors_cpe_metadata_is_object;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t      ON t.oid = c.conrelid
      JOIN pg_namespace n  ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'anchors'
       AND c.conname = 'anchors_cle_metadata_is_object'
       AND c.contype = 'c'
       AND c.convalidated = false
  ) THEN
    ALTER TABLE public.anchors VALIDATE CONSTRAINT anchors_cle_metadata_is_object;
  END IF;
END
$$;

COMMIT;

-- ============================================================================
-- ROLLBACK:
--   VALIDATE CONSTRAINT is a ONE-WAY operation and rollback is a NO-OP.
--   Once a constraint is validated, every existing row provably satisfies the
--   predicate, so there is nothing unsafe to undo. PostgreSQL has no
--   "INVALIDATE CONSTRAINT" — the only way to set convalidated = false again
--   would be to DROP the constraint and re-ADD it as NOT VALID, which would
--   REMOVE the guarantee this migration establishes and re-open the drift.
--   DO NOT do that. The correct rollback is: leave the constraints VALID.
--   (If the constraints themselves ever need to be removed, that is the
--   province of 0315's rollback block, not this validation-only migration.)
-- ============================================================================
