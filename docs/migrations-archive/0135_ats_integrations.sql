-- ATS Integrations (ATT-04)
-- Stores webhook configuration for ATS providers (Greenhouse, Lever, generic)
-- ROLLBACK: DROP TABLE IF EXISTS ats_integrations;

CREATE TABLE ats_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  provider text NOT NULL CHECK (provider IN ('greenhouse', 'lever', 'generic')),
  webhook_secret text NOT NULL,
  callback_url text,
  field_mapping jsonb DEFAULT '{}',
  enabled boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE ats_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ats_integrations FORCE ROW LEVEL SECURITY;

-- RLS: org members can manage their org's integrations
CREATE POLICY "ats_integration_org_member" ON ats_integrations
  FOR ALL USING (
    org_id IN (
      SELECT org_id FROM profiles WHERE id = auth.uid()
    )
  );

CREATE INDEX idx_ats_integrations_org_id ON ats_integrations (org_id);
