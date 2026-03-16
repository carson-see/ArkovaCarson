-- Migration 0064: P8 Phase II — AI Intelligence Tables
-- Stories: P8-S6 (Extraction Feedback), P8-S8 (Integrity Scores),
--          P8-S9 (Review Queue), P8-S16 (AI Reports)
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS ai_reports CASCADE;
--   DROP TABLE IF EXISTS review_queue_items CASCADE;
--   DROP TABLE IF EXISTS integrity_scores CASCADE;
--   DROP TABLE IF EXISTS extraction_feedback CASCADE;
--   DROP TYPE IF EXISTS review_status CASCADE;
--   DROP TYPE IF EXISTS review_action CASCADE;
--   DROP TYPE IF EXISTS report_status CASCADE;
--   DROP TYPE IF EXISTS integrity_level CASCADE;

-- =============================================================================
-- ENUMS
-- =============================================================================

CREATE TYPE integrity_level AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'FLAGGED');
CREATE TYPE review_status AS ENUM ('PENDING', 'APPROVED', 'INVESTIGATING', 'ESCALATED', 'DISMISSED');
CREATE TYPE review_action AS ENUM ('APPROVE', 'INVESTIGATE', 'ESCALATE', 'DISMISS');
CREATE TYPE report_status AS ENUM ('QUEUED', 'GENERATING', 'COMPLETE', 'FAILED');

-- =============================================================================
-- P8-S6: EXTRACTION FEEDBACK (learning loop)
-- =============================================================================

CREATE TABLE extraction_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  anchor_id UUID REFERENCES anchors(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  credential_type TEXT NOT NULL,
  field_key TEXT NOT NULL,
  original_value TEXT,
  corrected_value TEXT,
  action TEXT NOT NULL CHECK (action IN ('accepted', 'rejected', 'edited')),
  original_confidence NUMERIC(4,3) CHECK (original_confidence >= 0 AND original_confidence <= 1),
  provider TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE extraction_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE extraction_feedback FORCE ROW LEVEL SECURITY;

-- Org members can view their org's feedback
CREATE POLICY extraction_feedback_select ON extraction_feedback
  FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
    OR user_id = auth.uid()
  );

-- Users can insert their own feedback
CREATE POLICY extraction_feedback_insert ON extraction_feedback
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- Index for accuracy tracking queries
CREATE INDEX idx_extraction_feedback_type_field
  ON extraction_feedback (credential_type, field_key);
CREATE INDEX idx_extraction_feedback_org
  ON extraction_feedback (org_id, created_at DESC);

-- =============================================================================
-- P8-S6: Accuracy tracking RPC
-- =============================================================================

CREATE OR REPLACE FUNCTION get_extraction_accuracy(
  p_credential_type TEXT DEFAULT NULL,
  p_org_id UUID DEFAULT NULL,
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  credential_type TEXT,
  field_key TEXT,
  total_suggestions BIGINT,
  accepted_count BIGINT,
  rejected_count BIGINT,
  edited_count BIGINT,
  acceptance_rate NUMERIC(5,2),
  avg_confidence NUMERIC(4,3)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ef.credential_type,
    ef.field_key,
    COUNT(*) AS total_suggestions,
    COUNT(*) FILTER (WHERE ef.action = 'accepted') AS accepted_count,
    COUNT(*) FILTER (WHERE ef.action = 'rejected') AS rejected_count,
    COUNT(*) FILTER (WHERE ef.action = 'edited') AS edited_count,
    ROUND(
      COUNT(*) FILTER (WHERE ef.action = 'accepted')::numeric / NULLIF(COUNT(*), 0) * 100,
      2
    ) AS acceptance_rate,
    ROUND(AVG(ef.original_confidence), 3) AS avg_confidence
  FROM extraction_feedback ef
  WHERE ef.created_at >= now() - (p_days || ' days')::interval
    AND (p_credential_type IS NULL OR ef.credential_type = p_credential_type)
    AND (p_org_id IS NULL OR ef.org_id = p_org_id)
  GROUP BY ef.credential_type, ef.field_key
  ORDER BY total_suggestions DESC;
END;
$$;

-- =============================================================================
-- P8-S8: INTEGRITY SCORES
-- =============================================================================

CREATE TABLE integrity_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_id UUID NOT NULL REFERENCES anchors(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  overall_score NUMERIC(5,2) NOT NULL CHECK (overall_score >= 0 AND overall_score <= 100),
  level integrity_level NOT NULL,
  -- Breakdown scores (each 0-100)
  metadata_completeness NUMERIC(5,2) DEFAULT 0,
  extraction_confidence NUMERIC(5,2) DEFAULT 0,
  issuer_verification NUMERIC(5,2) DEFAULT 0,
  duplicate_check NUMERIC(5,2) DEFAULT 0,
  temporal_consistency NUMERIC(5,2) DEFAULT 0,
  flags JSONB DEFAULT '[]'::jsonb,
  details JSONB DEFAULT '{}'::jsonb,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (anchor_id)
);

ALTER TABLE integrity_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrity_scores FORCE ROW LEVEL SECURITY;

-- Org members can view scores for their org's anchors
CREATE POLICY integrity_scores_select ON integrity_scores
  FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );

-- Only service_role can insert/update (computed server-side)
-- No insert/update policy for regular users

CREATE INDEX idx_integrity_scores_org_level
  ON integrity_scores (org_id, level);
CREATE INDEX idx_integrity_scores_anchor
  ON integrity_scores (anchor_id);

-- =============================================================================
-- P8-S9: REVIEW QUEUE
-- =============================================================================

CREATE TABLE review_queue_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_id UUID NOT NULL REFERENCES anchors(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integrity_score_id UUID REFERENCES integrity_scores(id) ON DELETE SET NULL,
  status review_status NOT NULL DEFAULT 'PENDING',
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority >= 0 AND priority <= 10),
  reason TEXT NOT NULL,
  flags JSONB DEFAULT '[]'::jsonb,
  assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  review_action review_action,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE review_queue_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_queue_items FORCE ROW LEVEL SECURITY;

-- Org admins can view and manage their org's review items
CREATE POLICY review_queue_select ON review_queue_items
  FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );

CREATE POLICY review_queue_update ON review_queue_items
  FOR UPDATE USING (
    org_id IN (
      SELECT p.org_id FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'ORG_ADMIN'
    )
  );

CREATE INDEX idx_review_queue_org_status
  ON review_queue_items (org_id, status, priority DESC);
CREATE INDEX idx_review_queue_anchor
  ON review_queue_items (anchor_id);

-- Update trigger for updated_at
CREATE OR REPLACE FUNCTION update_review_queue_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_review_queue_updated_at
  BEFORE UPDATE ON review_queue_items
  FOR EACH ROW
  EXECUTE FUNCTION update_review_queue_updated_at();

-- =============================================================================
-- P8-S16: AI REPORTS
-- =============================================================================

CREATE TABLE ai_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL CHECK (report_type IN ('integrity_summary', 'extraction_accuracy', 'credential_analytics', 'compliance_overview')),
  status report_status NOT NULL DEFAULT 'QUEUED',
  title TEXT NOT NULL,
  parameters JSONB DEFAULT '{}'::jsonb,
  result JSONB,
  file_url TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ai_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_reports FORCE ROW LEVEL SECURITY;

-- Org members can view their org's reports
CREATE POLICY ai_reports_select ON ai_reports
  FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );

-- Users can insert reports for their org
CREATE POLICY ai_reports_insert ON ai_reports
  FOR INSERT WITH CHECK (
    requested_by = auth.uid()
    AND org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );

CREATE INDEX idx_ai_reports_org_status
  ON ai_reports (org_id, status, created_at DESC);

-- =============================================================================
-- SEED: Add ENABLE_AI_REPORTS flag to switchboard
-- =============================================================================

INSERT INTO switchboard_flags (flag_key, enabled, description)
VALUES ('ENABLE_AI_REPORTS', false, 'Enable AI report generation (P8-S16)')
ON CONFLICT (flag_key) DO NOTHING;
