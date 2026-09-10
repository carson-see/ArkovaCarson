-- SCRUM-4539: clear old claim fields after bounded broadcast recovery.
-- 0442 is already applied and remains immutable. Its JSON expression parsed
-- as metadata || (recovery_fields - claim_keys), leaving keys from metadata
-- intact. Parenthesize the complete merged object before removing those keys.
-- Materialize the locked cohort once so all UPDATE plans share the same bound.
-- No signature, eligibility, row locking, ordering, batch limit, or ACL changes.
-- A later claim currently overwrites the stale values; this correction makes
-- the intermediate PENDING record accurately reflect that it is unclaimed.
-- Verified on an isolated complete Supabase schema with 10,000 stale rows,
-- unknown committed reply/retry, reserved-key removal, and unrelated-key retention.
-- Rollback: restore the exact two-argument function from 0442 using CREATE OR
-- REPLACE FUNCTION (retain its service-role-only grants), then reapply this file.
-- Rolling back restores stale claim metadata. No stored row rewrite is needed.

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.recover_stuck_broadcasts(
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
  WITH candidates AS MATERIALIZED (
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
  ), stuck AS (
    UPDATE public.anchors a
    SET status = 'PENDING',
        updated_at = now(),
        metadata = (COALESCE(a.metadata, '{}'::jsonb)
          || jsonb_build_object(
            '_recovery_reason', CASE a.status
              WHEN 'BROADCASTING' THEN 'stuck_broadcasting'
              ELSE 'stuck_submitted_null_txid'
            END,
            '_recovered_at', now()::text,
            '_recovered_from_status', a.status::text,
            '_previous_claimed_by', COALESCE(a.metadata->>'_claimed_by', 'unknown')
          ))
          - '_claimed_by'
          - '_claimed_at'
    WHERE a.id IN (
      SELECT id FROM candidates
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

