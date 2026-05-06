-- Migration: 0017_anchoring_jobs_proofs.sql
-- Description: Anchoring jobs queue and proof storage
-- Rollback: DROP TABLE IF EXISTS anchor_proofs; DROP TABLE IF EXISTS anchoring_jobs;

-- =============================================================================
-- ANCHORING JOBS TABLE
-- =============================================================================
-- Queue of pending anchoring work with safe claim mechanism

CREATE TYPE job_status AS ENUM ('pending', 'processing', 'completed', 'failed');

CREATE TABLE anchoring_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_id uuid NOT NULL REFERENCES anchors(id) ON DELETE CASCADE,
  status job_status NOT NULL DEFAULT 'pending',

  -- Claim mechanism for safe concurrent processing
  claimed_at timestamptz,
  claimed_by text,
  claim_expires_at timestamptz,

  -- Processing info
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  last_error text,

  -- Timing
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,

  -- Idempotency
  CONSTRAINT anchoring_jobs_anchor_unique UNIQUE (anchor_id)
);

CREATE INDEX idx_anchoring_jobs_status ON anchoring_jobs(status);
CREATE INDEX idx_anchoring_jobs_claimed ON anchoring_jobs(status, claimed_at, claim_expires_at)
  WHERE status IN ('pending', 'processing');
CREATE INDEX idx_anchoring_jobs_anchor_id ON anchoring_jobs(anchor_id);

-- =============================================================================
-- ANCHOR PROOFS TABLE
-- =============================================================================
-- Proof data for secured anchors

CREATE TABLE anchor_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_id uuid NOT NULL REFERENCES anchors(id) ON DELETE CASCADE,

  -- Chain proof data
  receipt_id text NOT NULL,
  block_height integer NOT NULL,
  block_timestamp timestamptz NOT NULL,
  merkle_root text,
  proof_path jsonb,

  -- Raw chain response
  raw_response jsonb,

  -- Timing
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT anchor_proofs_anchor_unique UNIQUE (anchor_id)
);

CREATE INDEX idx_anchor_proofs_anchor_id ON anchor_proofs(anchor_id);
CREATE INDEX idx_anchor_proofs_receipt_id ON anchor_proofs(receipt_id);

-- =============================================================================
-- JOB CLAIM FUNCTION
-- =============================================================================
-- Atomic job claim with lock timeout

CREATE OR REPLACE FUNCTION claim_anchoring_job(
  p_worker_id text,
  p_lock_duration_seconds integer DEFAULT 300
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id uuid;
BEGIN
  -- Atomically claim a pending job or expired claim
  UPDATE anchoring_jobs
  SET
    status = 'processing',
    claimed_at = now(),
    claimed_by = p_worker_id,
    claim_expires_at = now() + (p_lock_duration_seconds || ' seconds')::interval,
    attempts = attempts + 1,
    started_at = COALESCE(started_at, now())
  WHERE id = (
    SELECT id FROM anchoring_jobs
    WHERE status = 'pending'
       OR (status = 'processing' AND claim_expires_at < now())
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING id INTO v_job_id;

  RETURN v_job_id;
END;
$$;

-- =============================================================================
-- JOB COMPLETION FUNCTION
-- =============================================================================

CREATE OR REPLACE FUNCTION complete_anchoring_job(
  p_job_id uuid,
  p_success boolean,
  p_error text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE anchoring_jobs
  SET
    status = CASE WHEN p_success THEN 'completed'::job_status ELSE 'failed'::job_status END,
    completed_at = now(),
    last_error = p_error
  WHERE id = p_job_id;

  RETURN FOUND;
END;
$$;

-- =============================================================================
-- AUTO-CREATE JOB ON ANCHOR INSERT
-- =============================================================================

CREATE OR REPLACE FUNCTION auto_create_anchoring_job()
RETURNS TRIGGER AS $$
BEGIN
  -- Only create job for new PENDING anchors
  IF NEW.status = 'PENDING' THEN
    INSERT INTO anchoring_jobs (anchor_id)
    VALUES (NEW.id)
    ON CONFLICT (anchor_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER create_anchoring_job_on_insert
  AFTER INSERT ON anchors
  FOR EACH ROW
  EXECUTE FUNCTION auto_create_anchoring_job();

-- =============================================================================
-- RLS POLICIES
-- =============================================================================

ALTER TABLE anchoring_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE anchor_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE anchoring_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE anchor_proofs FORCE ROW LEVEL SECURITY;

-- Jobs: Only service role can access (worker only)
-- No policies for authenticated users

-- Proofs: Users can read proofs for their anchors
CREATE POLICY anchor_proofs_read_own ON anchor_proofs
  FOR SELECT
  TO authenticated
  USING (
    anchor_id IN (
      SELECT id FROM anchors
      WHERE user_id = auth.uid() OR org_id = get_user_org_id()
    )
  );

-- Grant access
GRANT SELECT ON anchor_proofs TO authenticated;
GRANT ALL ON anchoring_jobs TO service_role;
GRANT ALL ON anchor_proofs TO service_role;
GRANT EXECUTE ON FUNCTION claim_anchoring_job(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION complete_anchoring_job(uuid, boolean, text) TO service_role;

-- Comments
COMMENT ON TABLE anchoring_jobs IS 'Queue of pending anchoring work with safe claim mechanism';
COMMENT ON TABLE anchor_proofs IS 'Proof data for secured anchors';
COMMENT ON FUNCTION claim_anchoring_job IS 'Atomically claim a pending job with lock timeout';
COMMENT ON FUNCTION complete_anchoring_job IS 'Mark a job as completed or failed';
