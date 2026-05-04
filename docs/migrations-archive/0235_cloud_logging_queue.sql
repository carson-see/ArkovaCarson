-- Migration 0235: Cloud Logging sink for audit_events (GCP-MAX-03 / SCRUM-1063).
--
-- Buffer table the worker drains on a 1-minute cron. We buffer instead of
-- streaming because Cloud Logging can be transiently unavailable and
-- dropping audit rows on a 5xx is a SOC 2 finding waiting to happen.
--
-- Rows are inserted by a trigger on audit_events (not by any application
-- code — that way every new caller writes to audit_events and gets the
-- Cloud Logging pipe for free).
--
-- Worker drain job deletes rows after confirmed write. On a persistent
-- outage, rows accumulate here and the Monitoring SLO on queue depth
-- fires an alert (GCP-MAX-04).
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS audit_events_to_cloud_logging_queue ON audit_events;
--   DROP FUNCTION IF EXISTS enqueue_audit_for_cloud_logging();
--   DROP TABLE IF EXISTS cloud_logging_queue;

BEGIN;

CREATE TABLE IF NOT EXISTS cloud_logging_queue (
  id          BIGSERIAL PRIMARY KEY,
  -- Copy of audit_events.id so the drain can dedupe on insertId. Unique so
  -- duplicate triggers (shouldn't happen, but defense-in-depth) collapse.
  audit_id    UUID NOT NULL UNIQUE REFERENCES audit_events(id) ON DELETE CASCADE,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Retry-tracking in case one row keeps erroring. After `retry_count` > 10
  -- the drain logs and skips; SOC 2 runbook covers manual remediation.
  retry_count SMALLINT NOT NULL DEFAULT 0,
  last_error  TEXT
);

-- Drain order + retry filter are index-backed to keep the cron query fast
-- when the queue builds up during a Cloud Logging outage.
CREATE INDEX IF NOT EXISTS idx_cloud_logging_queue_drain_order
  ON cloud_logging_queue (enqueued_at ASC)
  WHERE retry_count < 10;

-- No RLS: only the worker service_role writes/reads this table. Lock it
-- anyway for defense-in-depth.
ALTER TABLE cloud_logging_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_logging_queue FORCE ROW LEVEL SECURITY;
-- Explicit "no one else can touch this" policy — only service_role (which
-- bypasses RLS) interacts. Anon + authenticated are denied.
CREATE POLICY cloud_logging_queue_no_user_access
  ON cloud_logging_queue
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

CREATE OR REPLACE FUNCTION enqueue_audit_for_cloud_logging()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- ON CONFLICT DO NOTHING — if the trigger somehow fires twice, we stay
  -- at-most-once. The Cloud Logging insertId dedup is the backstop.
  INSERT INTO cloud_logging_queue (audit_id)
  VALUES (NEW.id)
  ON CONFLICT (audit_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_events_to_cloud_logging_queue
  AFTER INSERT ON audit_events
  FOR EACH ROW
  EXECUTE FUNCTION enqueue_audit_for_cloud_logging();

COMMENT ON TABLE cloud_logging_queue IS
  'GCP-MAX-03: buffer for audit_events → Cloud Logging. Worker drains via /jobs/cloud-logging-drain every minute. Deletes rows on confirmed write.';

COMMENT ON TRIGGER audit_events_to_cloud_logging_queue ON audit_events IS
  'GCP-MAX-03: enqueue each new audit_events row for the Cloud Logging drain cron.';

COMMIT;
