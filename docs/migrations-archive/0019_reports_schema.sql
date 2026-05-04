-- Migration: 0019_reports_schema.sql
-- Description: Reports and report artifacts for lifecycle reports
-- Rollback: DROP TABLE IF EXISTS report_artifacts; DROP TABLE IF EXISTS reports;

-- =============================================================================
-- REPORTS TABLE
-- =============================================================================
-- Report requests and metadata

CREATE TYPE report_type AS ENUM ('anchor_summary', 'compliance_audit', 'activity_log', 'billing_history');
CREATE TYPE report_status AS ENUM ('pending', 'generating', 'completed', 'failed');

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,

  -- Report config
  report_type report_type NOT NULL,
  parameters jsonb NOT NULL DEFAULT '{}',

  -- Status
  status report_status NOT NULL DEFAULT 'pending',
  error_message text,

  -- Timing
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,

  -- Idempotency key (prevents duplicate generation)
  idempotency_key text UNIQUE
);

CREATE INDEX idx_reports_user_id ON reports(user_id);
CREATE INDEX idx_reports_org_id ON reports(org_id) WHERE org_id IS NOT NULL;
CREATE INDEX idx_reports_status ON reports(status);
CREATE INDEX idx_reports_created_at ON reports(created_at);

-- =============================================================================
-- REPORT ARTIFACTS TABLE
-- =============================================================================
-- Generated report files

CREATE TABLE report_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,

  -- File info
  filename text NOT NULL,
  mime_type text NOT NULL DEFAULT 'application/json',
  file_size integer,

  -- Storage
  storage_path text NOT NULL,

  -- Timing
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_report_artifacts_report_id ON report_artifacts(report_id);

-- =============================================================================
-- RLS POLICIES
-- =============================================================================

ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports FORCE ROW LEVEL SECURITY;
ALTER TABLE report_artifacts FORCE ROW LEVEL SECURITY;

-- Reports: Users can read/create their own reports
CREATE POLICY reports_read_own ON reports
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR org_id = get_user_org_id());

CREATE POLICY reports_insert_own ON reports
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND (org_id IS NULL OR org_id = get_user_org_id())
  );

-- Artifacts: Users can read artifacts for their reports
CREATE POLICY report_artifacts_read_own ON report_artifacts
  FOR SELECT
  TO authenticated
  USING (
    report_id IN (
      SELECT id FROM reports
      WHERE user_id = auth.uid() OR org_id = get_user_org_id()
    )
  );

-- Grant access
GRANT SELECT, INSERT ON reports TO authenticated;
GRANT SELECT ON report_artifacts TO authenticated;
GRANT ALL ON reports TO service_role;
GRANT ALL ON report_artifacts TO service_role;

-- Comments
COMMENT ON TABLE reports IS 'Report requests and metadata';
COMMENT ON TABLE report_artifacts IS 'Generated report files';
