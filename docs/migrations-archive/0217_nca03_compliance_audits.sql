-- Migration 0217: compliance_audits table for NCA "Audit My Organization" (NCA-03)
--
-- PURPOSE: Store org-level compliance audit results that aggregate
-- per-jurisdiction scoring + gap detection + NVI quarantine status into a
-- single record an org admin can reference over time.
--
-- An audit is computed by POST /api/v1/compliance/audit and retrievable
-- by GET /api/v1/compliance/audit/:id. Results are stored indefinitely
-- so the scorecard timeline (NCA-08) can chart history.
--
-- Jira: SCRUM-758 (NCA-03)
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS compliance_audits;

CREATE TABLE compliance_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  triggered_by UUID REFERENCES auth.users(id),
  -- Overall org-level compliance score (0-100), weighted across all
  -- applicable jurisdiction rules for the org.
  overall_score SMALLINT NOT NULL CHECK (overall_score >= 0 AND overall_score <= 100),
  overall_grade TEXT NOT NULL CHECK (overall_grade IN ('A','B','C','D','F')),
  -- JSONB payloads: per_jurisdiction[] breakdown, gaps[], quarantines[],
  -- timing stats. Schema is additive — new fields are nullable.
  per_jurisdiction JSONB NOT NULL DEFAULT '[]',
  gaps JSONB NOT NULL DEFAULT '[]',
  quarantines JSONB NOT NULL DEFAULT '[]',
  -- Audit status — idempotency signal for in-flight / completed / failed runs.
  status TEXT NOT NULL DEFAULT 'COMPLETED'
    CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED')),
  -- Timings.
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,
  -- Error info, when status = FAILED.
  error_code TEXT,
  error_message TEXT,
  -- Optional jurisdiction filter echoed back for reproducibility.
  jurisdiction_filter TEXT[],
  -- Freeform metadata (NCA-05/06/08 will append here rather than add columns).
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE compliance_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_audits FORCE ROW LEVEL SECURITY;

-- Org members can read their own audits.
CREATE POLICY "Org members can read their org audits"
  ON compliance_audits FOR SELECT USING (
    org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );

-- Inserts are worker-only via service_role. The POST /audit endpoint
-- authenticates via org_id in the session, then the worker writes using
-- service_role so we don't have to mint a per-request policy.

CREATE INDEX idx_compliance_audits_org_recent
  ON compliance_audits (org_id, created_at DESC);

CREATE INDEX idx_compliance_audits_status
  ON compliance_audits (org_id, status, created_at DESC)
  WHERE status IN ('QUEUED','RUNNING');

-- Trigger to keep updated_at current.
CREATE OR REPLACE FUNCTION touch_compliance_audits_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ SET search_path = public;

CREATE TRIGGER trg_compliance_audits_updated_at
  BEFORE UPDATE ON compliance_audits
  FOR EACH ROW EXECUTE FUNCTION touch_compliance_audits_updated_at();

NOTIFY pgrst, 'reload schema';
