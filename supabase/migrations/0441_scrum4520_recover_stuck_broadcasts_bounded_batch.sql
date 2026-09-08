-- SCRUM-4520 — bound recover_stuck_broadcasts() to a batch size.
--
-- ## The incident (staging rig txvvrxngyfnnqahujbld, 2026-09-07)
--
-- A batch-anchoring run on arkova-worker-oldest-worker-0905-staging (worker
-- source 19abd51339cd69ca289bf7fe0c7195f7746646ec) was interrupted mid-flight
-- by a Cloud Run SIGTERM, leaving 10,000 `anchors` rows BROADCASTING with a
-- NULL `chain_tx_id` — exactly the cohort this function exists to recover.
--
-- It could not recover them. `POST /jobs/recover-broadcasts` returned 200 on
-- every pass while the worker logged, at pino level 40:
--
--     "recover_stuck_broadcasts RPC failed — falling back to manual recovery"
--     error: { code: "57014", message: "canceling statement due to statement timeout" }
--
-- The function selects `FOR UPDATE SKIP LOCKED` but took **no LIMIT**: one
-- call attempted to lock, update and return all 10,000 rows in a single
-- statement, and blew through the function's own `SET statement_timeout =
-- '60s'` every time. The row count never moved across three passes over ~10
-- minutes and the cohort had to be deleted by hand to stop the every-2-minute
-- recovery cron re-attempting it.
--
-- This is a liveness bug, not a cosmetic one: a stuck BROADCASTING cohort
-- head-of-line blocks batch anchoring. `batch_insert_anchors` keeps returning
-- the same oldest-first records, `partitionRecordAnchors` buckets the
-- BROADCASTING rows nowhere, and the drain reports "no new pending" with a
-- 200 (see services/worker/src/jobs/agents.md, `revertClaimedAnchors` entry).
-- An unbounded recovery function means the queue never drains.
--
-- ## The fix
--
-- Add `p_limit` (default 500, clamped server-side to [1, 2000]) and
-- `ORDER BY updated_at ASC` to the inner claim query, so:
--
--   * one call always completes far inside the 60s statement timeout,
--   * the caller loops over bounded batches until a pass comes back short
--     (services/worker/src/jobs/broadcast-recovery.ts), and
--   * the oldest rows — the actual head-of-line blockers — clear first.
--
-- The clamp is deliberate: a caller cannot re-create the unbounded sweep by
-- passing a huge `p_limit`, and `COALESCE` keeps an explicit NULL safe.
-- Ordering is the same claim shape `claim_pending_anchors` already uses
-- (baseline_at_main_HEAD.sql:1531) — `ORDER BY ... FOR UPDATE SKIP LOCKED
-- LIMIT n`. A batch shorter than the limit therefore means "nothing more that
-- this sweep may claim"; rows another concurrent sweep holds are that sweep's
-- to finish, which is exactly what SKIP LOCKED is for.
--
-- ## Why DROP + CREATE rather than CREATE OR REPLACE
--
-- Postgres treats an added parameter as a NEW signature, so a bare
-- `CREATE OR REPLACE ... (p_stale_minutes integer DEFAULT 5, p_limit integer
-- DEFAULT 500)` would leave the old 1-arg function in place alongside it, and
-- every existing `recover_stuck_broadcasts(5)` call would then fail as
-- ambiguous — the "function overloads differing only by DEFAULT" trap in
-- CLAUDE.md §6. The old signature is dropped first and the grant/revoke state
-- is re-established explicitly on the new one below.
--
-- Callers are unaffected: PostgREST resolves by named argument, so the
-- worker's `db.rpc('recover_stuck_broadcasts', { p_stale_minutes, p_limit })`
-- and any positional `recover_stuck_broadcasts(5)` both bind to the new
-- function with `p_limit` defaulted. Nothing else in the tree calls it — the
-- only references are this migration chain, comments, and test harnesses.
--
-- Everything else is preserved byte-for-byte from 0379: the
-- BROADCASTING+SUBMITTED cohort, the `chain_tx_id IS NULL` double-broadcast
-- guard, `deleted_at IS NULL`, the SCRUM-2692 `anchor_txid_journal`
-- PENDING/HELD protection, `FOR UPDATE SKIP LOCKED`, the reset-to-PENDING
-- metadata shape (`_recovery_reason` / `_recovered_at` /
-- `_recovered_from_status` / `_previous_claimed_by`), the deliberate absence
-- of a `legal_hold` check (recovery-to-PENDING is not a delete/revoke/
-- supersede), SECURITY DEFINER + pinned `search_path`, the 60s
-- `statement_timeout`, and the RETURNS TABLE row shape.
--
-- Tier: T3 (touches supabase/migrations/, anchor lifecycle recovery path).

SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS public.recover_stuck_broadcasts(integer);

CREATE FUNCTION public.recover_stuck_broadcasts(
  p_stale_minutes integer DEFAULT 5,
  p_limit integer DEFAULT 500
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
      ORDER BY a2.updated_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 2000)
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

REVOKE ALL ON FUNCTION public.recover_stuck_broadcasts(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_stuck_broadcasts(integer, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ROLLBACK (run on an isolated mirror, then re-apply this migration):
--   Drop the bounded two-argument function and restore 0379's unbounded
--   one-argument definition verbatim. NOTE: rolling back re-introduces the
--   SCRUM-4520 statement-timeout stall on any cohort large enough to exceed
--   the 60s statement_timeout — roll back only alongside a worker revision
--   that does not pass p_limit.
--
--   SET LOCAL lock_timeout = '5s';
--   DROP FUNCTION IF EXISTS public.recover_stuck_broadcasts(integer, integer);
--
--   CREATE FUNCTION public.recover_stuck_broadcasts(
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
--               '_recovery_reason', CASE a.status
--                 WHEN 'BROADCASTING' THEN 'stuck_broadcasting'
--                 ELSE 'stuck_submitted_null_txid'
--               END,
--               '_recovered_at', now()::text,
--               '_recovered_from_status', a.status::text,
--               '_previous_claimed_by', COALESCE(a.metadata->>'_claimed_by', 'unknown')
--             )
--             - '_claimed_by'
--             - '_claimed_at'
--       WHERE a.id IN (
--         SELECT a2.id
--         FROM public.anchors a2
--         WHERE a2.status IN ('BROADCASTING', 'SUBMITTED')
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
