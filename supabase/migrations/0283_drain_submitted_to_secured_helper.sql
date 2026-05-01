-- 2026-04-29 emergency hotfix: bulk SECURED UPDATE on 10k rows reliably
-- timed out at PostgREST's 60s ceiling because of trigger overhead
-- (5 BEFORE-UPDATE triggers × 10k rows = 50k function invocations) plus
-- autovacuum I/O competition. Result: 14-day SECURED gap (Apr 15 → Apr 29).
-- 1.18M anchors stuck in SUBMITTED on confirmed Bitcoin txs.
--
-- ROLLBACK: DROP TRIGGER IF EXISTS prevent_metadata_edit_trigger ON
--           public.anchors; -- (only if we want it back, was a duplicate)
--           DROP FUNCTION IF EXISTS public.drain_submitted_to_secured_for_tx;
--           restore the prior public.refresh_pipeline_dashboard_cache()
--           implementation from migration 0265.
--
-- Three things land together:
--   1. drop the duplicate prevent_metadata_edit_trigger (dup of trg_prevent_metadata_edit)
--   2. add advisory lock + 90s hard timeout to refresh_pipeline_dashboard_cache
--      so the every-5-min cron tick can't stack zombie queries
--   3. add drain_submitted_to_secured_for_tx() helper that batches the
--      SUBMITTED → SECURED UPDATE in 100-row chunks so it fits under
--      the 60s PostgREST timeout. The worker calls this in a loop.
--
-- SECURITY: drain_submitted_to_secured_for_tx is SECURITY DEFINER because
-- the worker calls it through PostgREST; do not leave the default PUBLIC
-- EXECUTE grant in place.

-- ── 1. Drop duplicate trigger ────────────────────────────────────────
DROP TRIGGER IF EXISTS prevent_metadata_edit_trigger ON public.anchors;

-- ── 2. Advisory-lock-guarded refresh_pipeline_dashboard_cache ────────
CREATE OR REPLACE FUNCTION public.refresh_pipeline_dashboard_cache()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout TO '90s'
AS $function$
DECLARE
  v_started_at timestamptz := clock_timestamp();
  v_errors jsonb := '[]'::jsonb;
  v_succeeded int := 0;
  v_got_lock boolean;
BEGIN
  SELECT pg_try_advisory_lock(8675309, 1) INTO v_got_lock;
  IF NOT v_got_lock THEN
    RETURN jsonb_build_object(
      'status', 'skipped',
      'reason', 'another refresh in progress',
      'duration_ms', extract(milliseconds from clock_timestamp() - v_started_at)::int
    );
  END IF;

  BEGIN
    BEGIN PERFORM refresh_cache_pipeline_stats(); v_succeeded := v_succeeded + 1;
    EXCEPTION WHEN OTHERS THEN v_errors := v_errors || jsonb_build_object('pipeline_stats', SQLERRM); END;

    BEGIN PERFORM refresh_cache_anchor_status_counts(); v_succeeded := v_succeeded + 1;
    EXCEPTION WHEN OTHERS THEN v_errors := v_errors || jsonb_build_object('anchor_status_counts', SQLERRM); END;

    BEGIN PERFORM refresh_cache_by_source(); v_succeeded := v_succeeded + 1;
    EXCEPTION WHEN OTHERS THEN v_errors := v_errors || jsonb_build_object('by_source', SQLERRM); END;

    BEGIN PERFORM refresh_cache_anchor_type_counts(); v_succeeded := v_succeeded + 1;
    EXCEPTION WHEN OTHERS THEN v_errors := v_errors || jsonb_build_object('anchor_type_counts', SQLERRM); END;

    BEGIN PERFORM refresh_cache_record_types(); v_succeeded := v_succeeded + 1;
    EXCEPTION WHEN OTHERS THEN v_errors := v_errors || jsonb_build_object('record_types', SQLERRM); END;

    BEGIN PERFORM refresh_cache_anchor_tx_stats(); v_succeeded := v_succeeded + 1;
    EXCEPTION WHEN OTHERS THEN v_errors := v_errors || jsonb_build_object('anchor_tx_stats', SQLERRM); END;

    PERFORM pg_advisory_unlock(8675309, 1);

    RETURN jsonb_build_object(
      'status', 'refreshed',
      'succeeded', v_succeeded,
      'errors', v_errors,
      'duration_ms', extract(milliseconds from clock_timestamp() - v_started_at)::int
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_advisory_unlock(8675309, 1);
    RAISE;
  END;
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_pipeline_dashboard_cache() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_pipeline_dashboard_cache() TO service_role;

-- ── 3. Batched drain helper ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.drain_submitted_to_secured_for_tx(
  p_chain_tx_id text,
  p_block_height int,
  p_block_timestamp timestamptz,
  p_batch_size int DEFAULT 100,
  p_max_iterations int DEFAULT 5
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout TO '50s'
AS $function$
DECLARE
  v_updated int;
  v_updated_anchors jsonb;
  v_anchors jsonb := '[]'::jsonb;
  v_total_updated int := 0;
  v_iterations int := 0;
BEGIN
  -- Tell BEFORE-UPDATE triggers to short-circuit. SECURITY DEFINER doesn't
  -- change get_caller_role()'s reading of the JWT claim GUC.
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  LOOP
    WITH batch AS (
      SELECT id FROM anchors
      WHERE chain_tx_id = p_chain_tx_id
        AND status = 'SUBMITTED'
        AND deleted_at IS NULL
      ORDER BY created_at ASC
      LIMIT p_batch_size
      FOR UPDATE SKIP LOCKED
    ),
    updated AS (
      UPDATE anchors a
      SET status = 'SECURED',
          chain_block_height = p_block_height,
          chain_timestamp = p_block_timestamp
      FROM batch
      WHERE a.id = batch.id
      RETURNING a.public_id, a.org_id
    )
    SELECT
      count(*)::int,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'public_id', public_id,
            'org_id', org_id
          )
        ),
        '[]'::jsonb
      )
    INTO v_updated, v_updated_anchors
    FROM updated;

    v_total_updated := v_total_updated + v_updated;
    v_anchors := v_anchors || v_updated_anchors;
    v_iterations := v_iterations + 1;

    EXIT WHEN v_updated < p_batch_size OR v_iterations >= p_max_iterations;
  END LOOP;

  RETURN jsonb_build_object(
    'tx_id', p_chain_tx_id,
    'updated', v_total_updated,
    'iterations', v_iterations,
    'anchors', v_anchors,
    'capped', v_iterations >= p_max_iterations
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.drain_submitted_to_secured_for_tx(text, int, timestamptz, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.drain_submitted_to_secured_for_tx(text, int, timestamptz, int, int) TO service_role;
