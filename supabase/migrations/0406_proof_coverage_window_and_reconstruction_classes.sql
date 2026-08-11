-- 0406: proof-coverage window RPC + reconstruction outcome classes (SCRUM-3187)
--
-- WHY
--   Arkova's headline promise is offline, forever verification of any secured
--   document, which requires a per-document Merkle inclusion proof. As of
--   2026-08-11 prod holds 3,474,760 SECURED anchors and 505,357 anchor_proofs
--   rows: 2,969,630 secured records have no per-document proof, and
--   proof_completeness_class was NULL on 100% of rows, so nothing recorded WHY.
--
--   This migration adds (a) a bounded RPC the forward-path coverage monitor can
--   call without scanning the 3.5M-row anchors table, and (b) the vocabulary
--   for recording the honest per-record reconstruction outcome — including the
--   outcome "this can never have an offline proof", which must be sayable.
--
-- WHAT THIS DOES NOT DO
--   No backfill, no data rewrite, no proof is created here. Populating the
--   class column is the job's work, and every proof it writes is validated
--   against the on-chain committed root first.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.proof_coverage_window(integer);
--   -- the comment below is metadata only; to fully revert:
--   COMMENT ON COLUMN public.anchor_proofs.proof_completeness_class IS NULL;

-- ---------------------------------------------------------------------------
-- 1. Forward-path coverage probe
-- ---------------------------------------------------------------------------
--
-- Bounded by created_at so it rides idx_anchors_status_created
-- (status, created_at DESC) WHERE deleted_at IS NULL and never degenerates
-- into a full scan (R0-8 / SCRUM-1254: no unbounded count(*) on anchors).
-- p_hours is clamped so a caller cannot turn this into a full-table aggregate.
CREATE OR REPLACE FUNCTION public.proof_coverage_window(p_hours integer DEFAULT 24)
RETURNS TABLE (secured bigint, with_proof bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    count(*)::bigint                       AS secured,
    count(p.anchor_id)::bigint             AS with_proof
  FROM public.anchors a
  LEFT JOIN public.anchor_proofs p ON p.anchor_id = a.id
  WHERE a.status = 'SECURED'
    AND a.deleted_at IS NULL
    AND a.created_at >= now() - (least(greatest(coalesce(p_hours, 24), 1), 168) * interval '1 hour');
$$;

COMMENT ON FUNCTION public.proof_coverage_window(integer) IS
  'SCRUM-3187: forward-path proof coverage over the last p_hours (clamped 1..168). '
  'Returns SECURED anchors created in the window and how many have an anchor_proofs row. '
  'Deliberately window-bounded: lifetime coverage is dominated by the known pre-2026-08 '
  'backlog and would keep the coverage alarm permanently red.';

REVOKE ALL ON FUNCTION public.proof_coverage_window(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.proof_coverage_window(integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Reconstruction outcome vocabulary
-- ---------------------------------------------------------------------------
--
-- Extends the 0354 classifier vocabulary with the outcomes the reconstruction
-- engine can reach. No CHECK constraint is added: a constraint on a 3.5M-row
-- table buys little here and the writer is a single service_role job, whereas
-- a rejected write mid-backfill would strand a run. The comment is the
-- contract; `scripts/ci` lints the writer against it.
--
--   Existing (0354):
--     already_complete   - proof row present with a usable branch
--     batch_provable     - part of a multi-leaf batch, branch rebuildable
--     direct_anchored    - single-leaf batch (root == fingerprint)
--     ambiguous          - could not be classified
--
--   Added (0406):
--     recovered_branch          - branch rebuilt and VERIFIED against the
--                                 on-chain committed root
--     recovered_single_leaf     - single-leaf batch whose committed root was
--                                 confirmed on-chain to equal the fingerprint
--     unreconstructible_order   - leaf SET is provably correct but the committed
--                                 leaf ORDER was never persisted and is not
--                                 derivable; no offline proof can ever be
--                                 emitted for this record without it
--     unreconstructible_no_root - the tx OP_RETURN could not be read, so there
--                                 is nothing to verify against
--     rejected_stored_branch    - a legacy anchors.metadata.merkle_proof exists
--                                 but does NOT verify against the committed
--                                 root; it is recorded as rejected, never used
COMMENT ON COLUMN public.anchor_proofs.proof_completeness_class IS
  'Honest per-record proof state. 0354: already_complete | batch_provable | direct_anchored | ambiguous. '
  '0406 (SCRUM-3187): recovered_branch | recovered_single_leaf | unreconstructible_order | '
  'unreconstructible_no_root | rejected_stored_branch. '
  'unreconstructible_* is a TERMINAL, truthful state: the record cannot be verified offline. '
  'It must be surfaced to the caller, never presented as a pending or transient condition.';
