BEGIN;

-- =============================================================================
-- 0353 — Reset drain-charged-but-unsubmitted connector anchors to PENDING so the
--        batch claims + submits them promptly (QUEUE-06 design-C, SCRUM-2352 F1)
--
-- WHY THIS EXISTS (the submission-latency bug):
--   The connector drain charges AT SECURING via debit_and_enqueue_anchor, which
--   atomically debits one credit AND moves the anchor PENDING → BROADCASTING (this
--   is the single, billing-correct charge — enforcement-independent, race-free).
--   But processBatchAnchors claims ONLY status='PENDING', so it never submits the
--   already-BROADCASTING connector anchor: it sits BROADCASTING until the generic
--   recover_stuck_broadcasts stale-timeout resets it. That is a submission LATENCY
--   bug, not a billing bug (the charge already landed exactly once).
--
--   This RPC resets ONLY the drain's stuck connector anchors back to PENDING so the
--   existing claim_pending_anchors path claims (leases, SKIP LOCKED → no double
--   submit) and submits them in the SAME batch pass. The credit charge is on the
--   anchor id and PERSISTS across the reset (never refunded, never re-debited) — so
--   exactly one charge stands.
--
-- PRECISE, SAFE TARGETING (no time-based staleness, no ordinary-anchor disruption):
--   * status='BROADCASTING' AND chain_tx_id IS NULL  → not yet submitted
--   * metadata->>'connector_artifact_id' IS NOT NULL → connector-originated only
--   * metadata->>'_claimed_by' IS NULL               → NEVER batch-claimed, i.e.
--       moved to BROADCASTING by the drain's debit, NOT by claim_pending_anchors.
--       This excludes anchors a batch worker is actively mid-broadcasting (those
--       carry _claimed_by), so we never yank an in-flight ordinary/queue anchor.
--   * FOR UPDATE SKIP LOCKED + p_org_id scope + p_limit bound.
--   Idempotent by construction: once claim_pending_anchors claims a reset anchor it
--   stamps _claimed_by, so a later reset pass will not re-select it (no reset loop).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.reset_unclaimed_connector_broadcasts(
  p_org_id uuid,
  p_limit integer DEFAULT 500
)
RETURNS TABLE(id uuid, fingerprint text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'p_org_id is required';
  END IF;

  RETURN QUERY
  WITH stuck AS (
    UPDATE anchors a
    SET
      status = 'PENDING',
      updated_at = now(),
      metadata = COALESCE(a.metadata, '{}'::jsonb)
        || jsonb_build_object(
          '_connector_resubmit_reset_at', now()::text
        )
    WHERE a.id IN (
      SELECT a2.id
      FROM anchors a2
      WHERE a2.org_id = p_org_id
        AND a2.status = 'BROADCASTING'
        AND a2.chain_tx_id IS NULL
        AND a2.deleted_at IS NULL
        AND (a2.metadata->>'connector_artifact_id') IS NOT NULL
        AND (a2.metadata->>'_claimed_by') IS NULL
      ORDER BY a2.updated_at ASC
      LIMIT GREATEST(1, LEAST(p_limit, 5000))
      FOR UPDATE SKIP LOCKED
    )
    RETURNING a.id, a.fingerprint::text
  )
  SELECT stuck.id, stuck.fingerprint FROM stuck;
END;
$$;

REVOKE ALL ON FUNCTION public.reset_unclaimed_connector_broadcasts(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_unclaimed_connector_broadcasts(uuid, integer) TO service_role;

COMMENT ON FUNCTION public.reset_unclaimed_connector_broadcasts(uuid, integer) IS
  'QUEUE-06 design-C (SCRUM-2352 F1): reset drain-charged, never-batch-claimed '
  'connector BROADCASTING anchors to PENDING so claim_pending_anchors submits them '
  'promptly. Charge persists on the anchor id — exactly one charge. service_role only.';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ROLLBACK:
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.reset_unclaimed_connector_broadcasts(uuid, integer);
-- NOTIFY pgrst, 'reload schema';
-- COMMIT;
