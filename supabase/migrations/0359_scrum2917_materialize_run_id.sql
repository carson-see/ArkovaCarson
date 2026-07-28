-- 0359_scrum2917_materialize_run_id.sql
-- SCRUM-2917 (proof materializer) — rollback-marker column for materializer-
-- inserted anchor_proofs skeleton rows.
--
-- PREFIX RESERVATION: 0359 confirmed by CTO ruling (Confluence 110198785) via
-- SCRUM-2979. Lands strictly AFTER 0358 (unmerged chain-rail PR #1552).
-- FILE-ONLY THIS SLICE: this migration is authored but NOT applied anywhere
-- (no prod, no staging, no rig). Tier T3 (touches supabase/migrations/).
-- DO NOT APPLY until the RTE rig is stood up and an explicit go is given.
--
-- UPDATE 2026-07-27: APPLIED TO PROD ~13:26-13:32Z via Supabase MCP
-- (SET lock_timeout='5s' preamble; zero lock waits, anchoring uninterrupted)
-- after a 48h isolated-rig T3 soak — see PR #1615 "Staging Soak Evidence"
-- section for the full evidence block (rig, image digest, preflight,
-- E2E cycles). Ledger numeric head reconciled to 0364 at apply time per
-- CLAUDE.md §0 rule 10; confirmed still present via `list_migrations`
-- 2026-07-28 (head now 0366). The DO-NOT-APPLY note above described the
-- state at authoring time only and is kept verbatim as historical context.
--
-- WHAT / WHY: the SCRUM-2917 proof materializer INSERTs anchor_proofs rows for
-- back-catalogue anchors. Every row a materializer run creates is stamped with
-- that run's uuid in `materialize_run_id`, so a bad run can be rolled back
-- surgically:
--
--   DELETE FROM public.anchor_proofs
--   WHERE materialize_run_id = $1
--     AND merkle_root IS NULL
--     AND proof_path IS NULL
--     AND op_return_payload IS NULL;
--
-- removes ONLY the run's untouched skeletons — a row that has since been
-- reconstructed (merkle_root/proof_path populated by SCRUM-2471, or
-- op_return_payload populated for a direct anchor) no longer matches the
-- predicate and is never deleted. Existing rows stay NULL (column is additive
-- + nullable; §1.8 frozen verify-API schema stays additive).
--
-- INDEX: partial on `materialize_run_id IS NOT NULL` — the only read path is
-- per-run rollback/audit lookup; the partial predicate keeps the ~2.97M
-- pre-existing NULL rows out of the index entirely (near-zero size and no
-- write amplification on legacy rows).
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS public.idx_anchor_proofs_materialize_run_id;
--   ALTER TABLE public.anchor_proofs
--     DROP COLUMN IF EXISTS materialize_run_id;
--   NOTIFY pgrst, 'reload schema';

BEGIN;

ALTER TABLE public.anchor_proofs
  ADD COLUMN IF NOT EXISTS materialize_run_id uuid;

COMMENT ON COLUMN public.anchor_proofs.materialize_run_id IS
  'SCRUM-2917 proof-materializer rollback marker: uuid of the materializer run that INSERTed this row. NULL on all pre-materializer rows and on rows created by any other writer. Surgical rollback: DELETE ... WHERE materialize_run_id = $1 AND merkle_root IS NULL AND proof_path IS NULL AND op_return_payload IS NULL — removes only that run''s untouched skeletons; a row later reconstructed (branch persisted or direct-anchor payload populated) stops matching and is never deleted.';

CREATE INDEX IF NOT EXISTS idx_anchor_proofs_materialize_run_id
  ON public.anchor_proofs (materialize_run_id)
  WHERE materialize_run_id IS NOT NULL;

-- Reload PostgREST schema cache so the new column is visible to the API.
NOTIFY pgrst, 'reload schema';

COMMIT;
