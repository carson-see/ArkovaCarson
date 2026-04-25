-- =============================================================================
-- Migration 0236: Anchor backlog cleanup
-- Story: SCRUM-XXX (anchor backlog incident 2026-04-24)
-- Date: 2026-04-24
--
-- CONTEXT
-- -------
-- As of 2026-04-24 the anchors table carried a 2.95M-row PENDING backlog
-- dominated by pipeline records. Diagnosis surfaced three distinct issues the
-- worker had no visibility into:
--
--   1. DEAD QUEUE. The `anchoring_jobs` table + `auto_create_anchoring_job()`
--      trigger from migration 0017 were orphaned: no code path in `services/`
--      or `src/` claims, completes, or reads from that table. Every anchor
--      INSERT still fired the trigger, paying a SECURITY DEFINER INSERT into
--      `anchoring_jobs` for nothing — pure write amplification on the hot path.
--      Over time this accumulated ~2.95M never-claimed rows that tracked the
--      anchor backlog 1:1.
--   2. DUPLICATE INDEX. Production carried `idx_anchors_pending_status` which
--      is structurally identical to `idx_anchors_pending_claim` (from 0180).
--      It was created outside migration control — dropping it here brings
--      dev/prod back into alignment without affecting the query planner
--      (the claim query already uses `idx_anchors_pending_claim`).
--   3. NO OPS VISIBILITY RPC. Operators had to run multi-minute COUNT(*)
--      queries through the Supabase MCP to see backlog state. Adding a
--      fast, bounded-timeout RPC makes the backlog auditable in seconds and
--      lets the worker itself surface these metrics to ops.
--
-- Also: `ANALYZE anchors` at the end — planner stats had drifted 6 days stale
-- after the backlog accumulation, making the claim query slower than necessary.
--
-- CHANGES
-- -------
--   1. Drop the `create_anchoring_job_on_insert` trigger on anchors.
--   2. Drop `auto_create_anchoring_job()`, `claim_anchoring_job()`,
--      `complete_anchoring_job()` functions (all unreferenced by worker code).
--   3. Drop the `anchoring_jobs` table (FK ON DELETE CASCADE on anchors).
--   4. Drop the `job_status` enum (only used by anchoring_jobs).
--   5. Drop `idx_anchors_pending_status` IF EXISTS (dev/prod parity).
--   6. Create `get_anchor_backlog_stats()` RPC for ops visibility.
--   7. ANALYZE anchors to refresh planner statistics.
--
-- SAFETY
-- ------
-- `anchor_proofs` table and `anchor_proofs_read_own` policy from 0017 are
-- KEPT — that table IS used (`audit-export.ts` reads it). Only the dead
-- queue portion is dropped.
--
-- Verified dead-queue status by grepping the repo on 2026-04-24:
--   - services/**/*.ts — zero references to anchoring_jobs / claim_anchoring_job
--   - src/**/*.ts       — zero references
--   - Only database.types.ts (auto-generated) and seed.sql mention them;
--     both are updated in this PR.
--
-- ROLLBACK
-- --------
-- Re-running migration 0017 will restore the table/functions/trigger. The
-- data in `anchoring_jobs` cannot be recovered, but it was never read by
-- any code path, so loss of data is equivalent to truncation.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Drop the INSERT trigger (stops the write amplification immediately)
-- ─────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS create_anchoring_job_on_insert ON anchors;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Drop the functions (no other code references them)
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS auto_create_anchoring_job();
DROP FUNCTION IF EXISTS claim_anchoring_job(text, integer);
DROP FUNCTION IF EXISTS complete_anchoring_job(uuid, boolean, text);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Drop the table (cascades FK, drops dependent indexes)
-- ─────────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS anchoring_jobs;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Drop the now-unused enum
-- ─────────────────────────────────────────────────────────────────────────────
DROP TYPE IF EXISTS job_status;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Drop the duplicate partial index (if present in this environment)
-- ─────────────────────────────────────────────────────────────────────────────
-- `idx_anchors_pending_status` duplicates `idx_anchors_pending_claim` (from
-- migration 0180). It was created outside migration control in production.
-- Safe `IF EXISTS`: dev environments without it are unaffected.
DROP INDEX IF EXISTS idx_anchors_pending_status;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Operations-visibility RPC: get_anchor_backlog_stats()
-- ─────────────────────────────────────────────────────────────────────────────
-- Returns a snapshot of the anchor backlog broken down by status, pipeline
-- vs non-pipeline PENDING, unconfirmed SUBMITTED TXs, and oldest PENDING age.
-- Bounded at 15s statement timeout so it never stalls a console/dashboard.

CREATE OR REPLACE FUNCTION get_anchor_backlog_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout TO '15s'
AS $$
DECLARE
  v_pending_total        bigint;
  v_pending_pipeline     bigint;
  v_pending_non_pipeline bigint;
  v_broadcasting         bigint;
  v_submitted_unconfirmed bigint;
  v_secured              bigint;
  v_oldest_pending       timestamptz;
BEGIN
  -- PENDING total (uses idx_anchors_pending_claim).
  SELECT COUNT(*) INTO v_pending_total
  FROM anchors
  WHERE status = 'PENDING' AND deleted_at IS NULL;

  -- PENDING pipeline subset (same index, in-memory filter).
  SELECT COUNT(*) INTO v_pending_pipeline
  FROM anchors
  WHERE status = 'PENDING'
    AND deleted_at IS NULL
    AND (metadata->>'pipeline_source') IS NOT NULL;

  v_pending_non_pipeline := v_pending_total - v_pending_pipeline;

  -- BROADCASTING (uses idx_anchors_broadcasting_status from 0111).
  SELECT COUNT(*) INTO v_broadcasting
  FROM anchors
  WHERE status = 'BROADCASTING' AND deleted_at IS NULL;

  -- SUBMITTED without a confirmed block yet (still in Bitcoin mempool).
  SELECT COUNT(*) INTO v_submitted_unconfirmed
  FROM anchors
  WHERE status = 'SUBMITTED'
    AND deleted_at IS NULL
    AND chain_block_height IS NULL;

  -- SECURED total — rough proxy for "anchors the worker has fully processed".
  SELECT COUNT(*) INTO v_secured
  FROM anchors
  WHERE status = 'SECURED' AND deleted_at IS NULL;

  SELECT MIN(created_at) INTO v_oldest_pending
  FROM anchors
  WHERE status = 'PENDING' AND deleted_at IS NULL;

  RETURN jsonb_build_object(
    'pending_total',            v_pending_total,
    'pending_pipeline',         v_pending_pipeline,
    'pending_non_pipeline',     v_pending_non_pipeline,
    'broadcasting',             v_broadcasting,
    'submitted_unconfirmed',    v_submitted_unconfirmed,
    'secured',                  v_secured,
    'oldest_pending_created_at', v_oldest_pending,
    'oldest_pending_age_seconds',
      CASE
        WHEN v_oldest_pending IS NULL THEN NULL
        ELSE EXTRACT(EPOCH FROM (now() - v_oldest_pending))::bigint
      END,
    'collected_at', now()
  );
END;
$$;

COMMENT ON FUNCTION get_anchor_backlog_stats IS
  'Snapshot of the anchor backlog (counts per status + oldest PENDING age). '
  'Bounded at 15s. Safe to call frequently from dashboards / worker diagnostics.';

REVOKE EXECUTE ON FUNCTION get_anchor_backlog_stats() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION get_anchor_backlog_stats() TO service_role;
GRANT  EXECUTE ON FUNCTION get_anchor_backlog_stats() TO authenticated;

-- Reload PostgREST schema cache so the new RPC is immediately available.
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. ANALYZE outside the transaction (cheap but not instant on 3M rows).
-- ─────────────────────────────────────────────────────────────────────────────
ANALYZE anchors;
