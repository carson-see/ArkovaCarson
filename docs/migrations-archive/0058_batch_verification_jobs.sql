-- Migration 0058: Batch Verification Jobs (P4.5-TS-02 + P4.5-TS-06)
-- Creates table for async batch verification job tracking.

-- Batch verification jobs table
CREATE TABLE IF NOT EXISTS batch_verification_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'processing', 'complete', 'failed')),
  public_ids TEXT[] NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  results JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Index for API key lookups and cleanup
CREATE INDEX IF NOT EXISTS idx_batch_jobs_api_key ON batch_verification_jobs(api_key_id);
CREATE INDEX IF NOT EXISTS idx_batch_jobs_created_at ON batch_verification_jobs(created_at);

-- RLS
ALTER TABLE batch_verification_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_verification_jobs FORCE ROW LEVEL SECURITY;

-- Service role has full access (worker creates and manages jobs)
CREATE POLICY batch_jobs_service_all ON batch_verification_jobs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ROLLBACK: DROP TABLE IF EXISTS batch_verification_jobs CASCADE;
