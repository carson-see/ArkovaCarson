-- =============================================================================
-- Migration 0294: SCRUM-1130 durable 24-hour organization queue scheduler
-- Date: 2026-05-05
--
-- PURPOSE
-- -------
-- The product contract says each organization's queue runs automatically every
-- 24 hours unless an org admin runs it manually first. Existing code had:
--   * a manual /api/queue/run endpoint;
--   * a global /cron/batch-anchors endpoint;
--   * no durable per-org last-run state or scheduled due-org claim.
--
-- This migration adds per-org state, append-only-ish history, and a service
-- role RPC that atomically claims due orgs with row locks. The worker then
-- calls processBatchAnchors({ force: true, orgId }) for each returned org, so
-- scheduled runs use the same org-scoped anchoring safety rails as manual runs.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS claim_due_org_queue_runs(timestamptz, text, integer);
--   DROP TABLE IF EXISTS organization_queue_runs;
--   DROP TABLE IF EXISTS organization_queue_run_state;
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS organization_queue_run_state (
  org_id            uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  last_run_at       timestamptz,
  last_success_at   timestamptz,
  last_run_status   text NOT NULL DEFAULT 'idle'
                    CHECK (last_run_status IN ('idle', 'running', 'succeeded', 'failed')),
  last_run_trigger  text
                    CHECK (last_run_trigger IS NULL OR last_run_trigger IN ('manual', 'scheduled')),
  last_error        text,
  locked_at         timestamptz,
  locked_by         text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_org_queue_run_state_due
  ON organization_queue_run_state (last_run_at NULLS FIRST, org_id)
  WHERE locked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_org_queue_run_state_locked
  ON organization_queue_run_state (locked_at)
  WHERE locked_at IS NOT NULL;

COMMENT ON TABLE organization_queue_run_state IS
  'SCRUM-1130: durable per-organization queue scheduler state. Manual and scheduled runs update last_run_at so the 24-hour timer is deterministic.';

CREATE TABLE IF NOT EXISTS organization_queue_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  trigger           text NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  status            text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  idempotency_key   text NOT NULL,
  worker_id         text,
  triggered_by      uuid REFERENCES profiles(id) ON DELETE SET NULL,
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz NOT NULL,
  processed_count   integer NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  batch_id          text,
  merkle_root       text,
  tx_id             text,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_org_queue_runs_org_finished
  ON organization_queue_runs (org_id, finished_at DESC);

COMMENT ON TABLE organization_queue_runs IS
  'SCRUM-1130: history for manual and scheduled organization queue runs. Used for run evidence, diagnostics, and due-timer audits.';

ALTER TABLE organization_queue_run_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_queue_run_state FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_queue_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_queue_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_queue_run_state_service ON organization_queue_run_state;
CREATE POLICY org_queue_run_state_service ON organization_queue_run_state
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS org_queue_runs_service ON organization_queue_runs;
CREATE POLICY org_queue_runs_service ON organization_queue_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS org_queue_run_state_org_select ON organization_queue_run_state;
CREATE POLICY org_queue_run_state_org_select ON organization_queue_run_state
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.user_id = (SELECT auth.uid())
        AND om.org_id = organization_queue_run_state.org_id
    )
  );

DROP POLICY IF EXISTS org_queue_runs_org_select ON organization_queue_runs;
CREATE POLICY org_queue_runs_org_select ON organization_queue_runs
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.user_id = (SELECT auth.uid())
        AND om.org_id = organization_queue_runs.org_id
    )
  );

GRANT ALL ON organization_queue_run_state TO service_role;
GRANT ALL ON organization_queue_runs TO service_role;
GRANT SELECT ON organization_queue_run_state TO authenticated;
GRANT SELECT ON organization_queue_runs TO authenticated;

CREATE OR REPLACE FUNCTION claim_due_org_queue_runs(
  p_now timestamptz DEFAULT now(),
  p_worker_id text DEFAULT gen_random_uuid()::text,
  p_limit integer DEFAULT 25
)
RETURNS TABLE (
  org_id uuid,
  last_run_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer;
BEGIN
  v_limit := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);

  INSERT INTO organization_queue_run_state (org_id)
  SELECT DISTINCT a.org_id
  FROM anchors a
  WHERE a.org_id IS NOT NULL
    AND a.status = 'PENDING'::anchor_status
    AND a.deleted_at IS NULL
  ON CONFLICT (org_id) DO NOTHING;

  RETURN QUERY
  WITH due AS (
    SELECT s.org_id
    FROM organization_queue_run_state s
    WHERE EXISTS (
      SELECT 1
      FROM anchors a
      WHERE a.org_id = s.org_id
        AND a.status = 'PENDING'::anchor_status
        AND a.deleted_at IS NULL
    )
      AND (
        s.last_run_at IS NULL
        OR s.last_run_at <= p_now - interval '24 hours'
      )
      AND (
        s.locked_at IS NULL
        OR s.locked_at <= p_now - interval '15 minutes'
      )
    ORDER BY COALESCE(s.last_run_at, 'epoch'::timestamptz), s.org_id
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE organization_queue_run_state s
  SET
    last_run_status = 'running',
    locked_at = p_now,
    locked_by = p_worker_id,
    updated_at = p_now
  FROM due
  WHERE s.org_id = due.org_id
  RETURNING s.org_id, s.last_run_at;
END;
$$;

REVOKE EXECUTE ON FUNCTION claim_due_org_queue_runs(timestamptz, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_due_org_queue_runs(timestamptz, text, integer) TO service_role;

COMMENT ON FUNCTION claim_due_org_queue_runs(timestamptz, text, integer) IS
  'SCRUM-1130: atomically claim organizations whose queues are due for a 24-hour scheduled run. Worker must execute processBatchAnchors({ force: true, orgId }) and record completion.';

NOTIFY pgrst, 'reload schema';

COMMIT;
