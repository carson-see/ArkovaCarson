-- Migration 0195: Compliance scores table for NCE scoring engine (NCE-07)
--
-- PURPOSE: Store per-org, per-jurisdiction compliance scores computed by Nessie.
-- Scores are upserted by the worker via service_role; org members can read.
--
-- Jira: SCRUM-597
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS compliance_scores;

CREATE TABLE compliance_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id),
  jurisdiction_code TEXT NOT NULL,
  industry_code TEXT NOT NULL,
  score SMALLINT NOT NULL CHECK (score >= 0 AND score <= 100),
  grade TEXT NOT NULL CHECK (grade IN ('A', 'B', 'C', 'D', 'F')),
  present_documents JSONB DEFAULT '[]',
  missing_documents JSONB DEFAULT '[]',
  expiring_documents JSONB DEFAULT '[]',
  recommendations JSONB DEFAULT '[]',
  nessie_analysis_id UUID,
  last_calculated TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, jurisdiction_code, industry_code)
);

-- RLS: org members read, worker writes via service_role
ALTER TABLE compliance_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_scores FORCE ROW LEVEL SECURITY;

CREATE POLICY "Org members can read their org scores"
  ON compliance_scores FOR SELECT USING (
    org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );

CREATE INDEX idx_compliance_scores_org_lookup
  ON compliance_scores (org_id, jurisdiction_code, industry_code);

CREATE INDEX idx_compliance_scores_history
  ON compliance_scores (org_id, last_calculated DESC);

NOTIFY pgrst, 'reload schema';
