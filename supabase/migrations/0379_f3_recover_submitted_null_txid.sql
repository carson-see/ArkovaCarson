-- F-3 (2026-08 launch-72h-2026-08 / legacy-soak-2026-08 soak finding,
-- docs/staging/SOAK-FINDINGS-2026-08.md): `recover_stuck_broadcasts()`
-- (baseline_at_main_HEAD.sql:5051, hardened by 0358_scrum2692_anchor_txid_journal.sql)
-- only ever queried `status = 'BROADCASTING'`. An anchor left `SUBMITTED`
-- with a NULL `chain_tx_id` — the shape a broadcast attempt produces if it
-- fails between the status write and the txid write — is structurally
-- outside every scheduled job's WHERE clause and had NO recovery path.
-- Proven live during the 72h soak: fixture `5eed0000-0000-0000-0000-
-- 0000000000c1` sat in exactly this state, unrecovered, for multiple days.
--
-- Producer note (honest disclosure, not swept under the rug): every current
-- write site that sets `status = 'SUBMITTED'` was re-audited for this
-- migration (jobs/anchor.ts single-anchor path, jobs/batch-anchor.ts
-- submit_batch_anchors + bulkMarkSubmittedFallback, resolve_anchor_txid_journal's
-- ADOPT branch) and every one of them is a single-statement UPDATE that sets
-- `status` and `chain_tx_id` together, atomically — Postgres cannot split a
-- single UPDATE's column list across a crash boundary. No currently-live code
-- path was found that can produce this state going forward. The live
-- occurrence therefore either pre-dates one of the atomicity hardening passes
-- (RACE-1 / RACE-2 / S3-P0 / SCRUM-2692) or reflects an out-of-band write;
-- root-causing the exact producer is tracked separately from this
-- recovery-path fix, which — per the finding — is the actual gap: whatever
-- produced the row, nothing could ever get it unstuck.
--
-- machines/bitcoinAnchor.machine.ts INV-1b (submittedRequiresChainTx) states
-- this exact combination is unreachable through every *modeled* write path,
-- which matches the atomicity audit above. This migration does not weaken
-- that invariant or add a new modeled lifecycle transition — it is a pure
-- self-healing safety net for a state the design says should never occur,
-- structurally identical in spirit to the BROADCASTING branch it extends.
-- See the machine file's inline comment near submittedRequiresChainTx and
-- machines/agents.md for the corresponding entry.
--
-- Fix: CREATE OR REPLACE recover_stuck_broadcasts() to ALSO claim SUBMITTED
-- anchors with chain_tx_id IS NULL past the same stale threshold used for the
-- existing BROADCASTING branch. Both branches:
--   * exclude deleted_at IS NOT NULL
--   * exclude any anchor protected by an unresolved (PENDING/HELD)
--     anchor_txid_journal cohort row — identical protection to the existing
--     BROADCASTING branch. A SUBMITTED row can be journal-protected too:
--     journalAdopt/journalPersisted (resolve_anchor_txid_journal) leave a row
--     SUBMITTED while journal resolution is still in flight, and that window
--     must stay off-limits to the generic sweep exactly like BROADCASTING is.
--   * use FOR UPDATE SKIP LOCKED so concurrent recovery sweeps never
--     double-claim the same row
--   * reset to PENDING with the same recovery metadata shape
--     (_recovery_reason / _recovered_at / _previous_claimed_by), plus a new
--     _recovered_from_status field so an operator can tell which branch fired
--
-- legal_hold is deliberately NOT checked, matching the existing BROADCASTING
-- branch precedent: legal_hold blocks delete/revoke/supersede (see
-- anchors_legal_hold_no_delete CHECK, supersede_anchor(), revoke path) but
-- never blocked recovery-to-PENDING for a broadcast that never landed — the
-- anchor is not being deleted or having its evidentiary chain data forged, it
-- is being re-queued to complete the exact same lifecycle it was always on.
--
-- RETURNS TABLE shape is deliberately UNCHANGED (Postgres refuses a bare
-- CREATE OR REPLACE that alters an OUT-parameter row type — it would require
-- DROP FUNCTION first, which this migration avoids to keep the change
-- minimal and the grant/ownership state untouched). Per-row branch
-- provenance (BROADCASTING vs SUBMITTED) is still fully recoverable
-- after the fact via `anchors.metadata->>'_recovered_from_status'` — every
-- recovered row is stamped with it — without touching the RPC's public
-- signature.
--
-- `_recovery_reason` for the pre-existing BROADCASTING branch is preserved
-- byte-for-byte ('stuck_broadcasting') for backward compatibility with the
-- worker's manual RPC-unavailable fallback and its existing test assertions;
-- the new SUBMITTED branch uses 'stuck_submitted_null_txid'.
--
-- Tier: T3 (touches supabase/migrations/, anchor lifecycle recovery path).

CREATE OR REPLACE FUNCTION public.recover_stuck_broadcasts(
  p_stale_minutes integer DEFAULT 5
) RETURNS TABLE(
  anchor_id uuid,
  anchor_fingerprint text,
  claimed_by text,
  stuck_since timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '60s'
AS $$
BEGIN
  RETURN QUERY
  WITH stuck AS (
    UPDATE public.anchors a
    SET status = 'PENDING',
        updated_at = now(),
        metadata = COALESCE(a.metadata, '{}'::jsonb)
          || jsonb_build_object(
            '_recovery_reason', CASE a.status
              WHEN 'BROADCASTING' THEN 'stuck_broadcasting'
              ELSE 'stuck_submitted_null_txid'
            END,
            '_recovered_at', now()::text,
            '_recovered_from_status', a.status::text,
            '_previous_claimed_by', COALESCE(a.metadata->>'_claimed_by', 'unknown')
          )
          - '_claimed_by'
          - '_claimed_at'
    WHERE a.id IN (
      SELECT a2.id
      FROM public.anchors a2
      WHERE a2.status IN ('BROADCASTING', 'SUBMITTED')
        AND a2.updated_at < now() - (p_stale_minutes || ' minutes')::interval
        AND a2.deleted_at IS NULL
        AND a2.chain_tx_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.anchor_txid_journal j
          WHERE j.recovery_status IN ('PENDING', 'HELD')
            AND a2.id = ANY(j.anchor_ids)
        )
      FOR UPDATE SKIP LOCKED
    )
    RETURNING a.id,
      a.fingerprint::text,
      a.metadata->>'_previous_claimed_by' AS claimed_by,
      a.updated_at
  )
  SELECT stuck.id, stuck.fingerprint, stuck.claimed_by, stuck.updated_at
  FROM stuck;
END;
$$;

REVOKE ALL ON FUNCTION public.recover_stuck_broadcasts(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_stuck_broadcasts(integer) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ROLLBACK (run on an isolated mirror, then re-apply this migration):
--   Recreate the pre-0379 public.recover_stuck_broadcasts(integer) definition
--   exactly as it stands in 0358_scrum2692_anchor_txid_journal.sql
--   (BROADCASTING-only WHERE clause, no SUBMITTED branch):
--
--   CREATE OR REPLACE FUNCTION public.recover_stuck_broadcasts(
--     p_stale_minutes integer DEFAULT 5
--   ) RETURNS TABLE(
--     anchor_id uuid,
--     anchor_fingerprint text,
--     claimed_by text,
--     stuck_since timestamptz
--   )
--   LANGUAGE plpgsql
--   SECURITY DEFINER
--   SET search_path = public
--   SET statement_timeout = '60s'
--   AS $$
--   BEGIN
--     RETURN QUERY
--     WITH stuck AS (
--       UPDATE public.anchors a
--       SET status = 'PENDING',
--           updated_at = now(),
--           metadata = COALESCE(a.metadata, '{}'::jsonb)
--             || jsonb_build_object(
--               '_recovery_reason', 'stuck_broadcasting',
--               '_recovered_at', now()::text,
--               '_previous_claimed_by', COALESCE(a.metadata->>'_claimed_by', 'unknown')
--             )
--             - '_claimed_by'
--             - '_claimed_at'
--       WHERE a.id IN (
--         SELECT a2.id
--         FROM public.anchors a2
--         WHERE a2.status = 'BROADCASTING'
--           AND a2.updated_at < now() - (p_stale_minutes || ' minutes')::interval
--           AND a2.deleted_at IS NULL
--           AND a2.chain_tx_id IS NULL
--           AND NOT EXISTS (
--             SELECT 1
--             FROM public.anchor_txid_journal j
--             WHERE j.recovery_status IN ('PENDING', 'HELD')
--               AND a2.id = ANY(j.anchor_ids)
--           )
--         FOR UPDATE SKIP LOCKED
--       )
--       RETURNING a.id,
--         a.fingerprint::text,
--         a.metadata->>'_previous_claimed_by' AS claimed_by,
--         a.updated_at
--     )
--     SELECT stuck.id, stuck.fingerprint, stuck.claimed_by, stuck.updated_at
--     FROM stuck;
--   END;
--   $$;
--
--   REVOKE ALL ON FUNCTION public.recover_stuck_broadcasts(integer) FROM PUBLIC, anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.recover_stuck_broadcasts(integer) TO service_role;
--   NOTIFY pgrst, 'reload schema';
