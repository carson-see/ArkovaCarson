CREATE TABLE IF NOT EXISTS job_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
  priority integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  last_error text,
  scheduled_for timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_queue_claim
  ON job_queue(type, status, priority DESC, created_at ASC)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_job_queue_status
  ON job_queue(status)
  WHERE status IN ('pending', 'processing', 'failed');

CREATE INDEX IF NOT EXISTS idx_brin_job_queue_created
  ON job_queue USING brin(created_at);

ALTER TABLE job_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_queue FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE job_queue IS 'PERF-13: Async job queue for worker processing. Service-role only.';

CREATE OR REPLACE FUNCTION claim_next_job(p_type text, p_now timestamptz)
RETURNS SETOF job_queue
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
  UPDATE job_queue
  SET status = 'processing', attempts = attempts + 1, updated_at = p_now
  WHERE id = (
    SELECT id FROM job_queue
    WHERE type = p_type
      AND status IN ('pending', 'failed')
      AND (scheduled_for IS NULL OR scheduled_for <= p_now)
    ORDER BY priority DESC, created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$;;
