CREATE TABLE IF NOT EXISTS compliance_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  triggered_by UUID REFERENCES auth.users(id),
  overall_score SMALLINT NOT NULL CHECK (overall_score >= 0 AND overall_score <= 100),
  overall_grade TEXT NOT NULL CHECK (overall_grade IN ('A','B','C','D','F')),
  per_jurisdiction JSONB NOT NULL DEFAULT '[]',
  gaps JSONB NOT NULL DEFAULT '[]',
  quarantines JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'COMPLETED'
    CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,
  error_code TEXT,
  error_message TEXT,
  jurisdiction_filter TEXT[],
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE compliance_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_audits FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org members can read their org audits" ON compliance_audits;
CREATE POLICY "Org members can read their org audits"
  ON compliance_audits FOR SELECT USING (
    org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );

CREATE INDEX IF NOT EXISTS idx_compliance_audits_org_recent
  ON compliance_audits (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_compliance_audits_status
  ON compliance_audits (org_id, status, created_at DESC)
  WHERE status IN ('QUEUED','RUNNING');

CREATE OR REPLACE FUNCTION touch_compliance_audits_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ SET search_path = public;

DROP TRIGGER IF EXISTS trg_compliance_audits_updated_at ON compliance_audits;
CREATE TRIGGER trg_compliance_audits_updated_at
  BEFORE UPDATE ON compliance_audits
  FOR EACH ROW EXECUTE FUNCTION touch_compliance_audits_updated_at();

NOTIFY pgrst, 'reload schema';;
