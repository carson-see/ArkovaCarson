-- Migration 0256: claim_pending_rule_events returns payload (Drive folder rule binding)
--
-- PURPOSE
-- -------
-- The rules engine evaluator (services/worker/src/rules/evaluator.ts) reads
-- event.payload?.parent_ids to drive Drive folder rule bindings (SCRUM-1100).
-- The payload column was added to organization_rule_events in migration 0247,
-- but the original claim_pending_rule_events RPC only returns sanitized
-- routing fields (vendor / external_file_id / filename / etc.) — payload was
-- left out, so worker rows always saw payload = undefined and Drive folder
-- filters always rejected.
--
-- This migration:
--   1. Reasserts the payload column on organization_rule_events (idempotent).
--   2. Replaces claim_pending_rule_events so its RETURNS TABLE includes the
--      payload jsonb field, and the SELECT propagates it.
--
-- The function body is otherwise byte-for-byte identical to the version in
-- 0247: same stale-claim recovery, same FOR UPDATE SKIP LOCKED claim, same
-- LEAST/GREATEST limit guard.
--
-- JIRA: SCRUM-1099, SCRUM-1100
-- EPIC: SCRUM-1010 CIBA / SCRUM-1098 Connector first-six
--
-- ROLLBACK:
--   -- Drops the payload field from the function signature only. The payload
--   -- column on organization_rule_events stays (it was added in 0247 and is
--   -- already populated by enqueue_rule_event(...)).
--   DROP FUNCTION IF EXISTS claim_pending_rule_events(INTEGER);
--   -- ...then re-run the original definition from
--   -- supabase/migrations/0247_ciba_rule_event_queue.sql lines 164-231.

-- =============================================================================
-- 1. Idempotent payload column reassertion
-- =============================================================================
-- 0247 already adds this column with the same default. The IF NOT EXISTS makes
-- this migration safe to apply against environments that somehow skipped the
-- column (e.g. partially restored DB, branch reset).

ALTER TABLE organization_rule_events
  ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN organization_rule_events.payload IS
  'Provider-specific event metadata (e.g. Drive parent_ids, file_id) used by rule binding filters. Sanitized; no raw bodies.';

-- =============================================================================
-- 2. Replace claim_pending_rule_events to surface payload
-- =============================================================================

CREATE OR REPLACE FUNCTION claim_pending_rule_events(p_limit INTEGER DEFAULT 200)
RETURNS TABLE (
  id UUID,
  org_id UUID,
  trigger_type org_rule_trigger_type,
  vendor TEXT,
  external_file_id TEXT,
  filename TEXT,
  folder_path TEXT,
  sender_email TEXT,
  subject TEXT,
  payload JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
BEGIN
  -- Recover worker crashes / deploy interruptions. Attempt count is preserved
  -- so repeatedly failing events eventually park in FAILED by release RPC.
  UPDATE organization_rule_events e
  SET status = 'PENDING'::org_rule_event_status,
      claim_id = NULL,
      claimed_at = NULL,
      error = COALESCE(e.error, 'Recovered stale CLAIMED event')
  WHERE e.status = 'CLAIMED'
    AND e.claimed_at < now() - INTERVAL '15 minutes'
    AND e.attempt_count < 5;

  UPDATE organization_rule_events e
  SET status = 'FAILED'::org_rule_event_status,
      claim_id = NULL,
      error = COALESCE(e.error, 'Rule event exceeded max claim attempts')
  WHERE e.status = 'CLAIMED'
    AND e.claimed_at < now() - INTERVAL '15 minutes'
    AND e.attempt_count >= 5;

  RETURN QUERY
  WITH picked AS (
    SELECT q.id
    FROM organization_rule_events q
    WHERE q.status = 'PENDING'
    ORDER BY q.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT v_limit
  ),
  claimed AS (
    UPDATE organization_rule_events q
    SET status = 'CLAIMED'::org_rule_event_status,
        claim_id = gen_random_uuid(),
        claimed_at = now(),
        attempt_count = q.attempt_count + 1,
        error = NULL
    FROM picked
    WHERE q.id = picked.id
    RETURNING
      q.id, q.org_id, q.trigger_type, q.vendor, q.external_file_id,
      q.filename, q.folder_path, q.sender_email, q.subject, q.payload
  )
  SELECT
    claimed.id, claimed.org_id, claimed.trigger_type, claimed.vendor,
    claimed.external_file_id, claimed.filename, claimed.folder_path,
    claimed.sender_email, claimed.subject, claimed.payload
  FROM claimed
  ORDER BY claimed.id ASC;
END;
$$;

REVOKE ALL ON FUNCTION claim_pending_rule_events(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_pending_rule_events(INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_pending_rule_events(INTEGER) TO service_role;

-- PostgREST schema cache reload — new return shape must be picked up before
-- the worker's next claim cycle.
NOTIFY pgrst, 'reload schema';
