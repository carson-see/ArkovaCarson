-- P5-TS-07: credential_templates table for reusable credential configurations
-- Templates allow org admins to pre-define credential types with metadata schemas

CREATE TABLE credential_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  credential_type credential_type NOT NULL,
  default_metadata jsonb DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT credential_templates_name_length CHECK (char_length(name) >= 1 AND char_length(name) <= 255),
  CONSTRAINT credential_templates_description_length CHECK (description IS NULL OR char_length(description) <= 2000),
  CONSTRAINT credential_templates_metadata_is_object CHECK (
    default_metadata IS NULL OR jsonb_typeof(default_metadata) = 'object'
  ),
  CONSTRAINT credential_templates_unique_name_per_org UNIQUE (org_id, name)
);

-- Indexes
CREATE INDEX idx_credential_templates_org_id ON credential_templates(org_id);
CREATE INDEX idx_credential_templates_credential_type ON credential_templates(credential_type);

-- Updated_at trigger (uses moddatetime extension from 0016_billing_schema.sql)
CREATE TRIGGER set_credential_templates_updated_at
  BEFORE UPDATE ON credential_templates
  FOR EACH ROW
  EXECUTE FUNCTION moddatetime(updated_at);

-- RLS
ALTER TABLE credential_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_templates FORCE ROW LEVEL SECURITY;

-- ORG_ADMIN users can read templates for their org
CREATE POLICY credential_templates_select ON credential_templates
  FOR SELECT
  TO authenticated
  USING (
    org_id IN (
      SELECT p.org_id FROM profiles p WHERE p.id = auth.uid()
    )
  );

-- ORG_ADMIN users can create templates for their org
CREATE POLICY credential_templates_insert ON credential_templates
  FOR INSERT
  TO authenticated
  WITH CHECK (
    org_id IN (
      SELECT p.org_id FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'ORG_ADMIN'
    )
    AND (created_by IS NULL OR created_by = auth.uid())
  );

-- ORG_ADMIN users can update templates for their org
CREATE POLICY credential_templates_update ON credential_templates
  FOR UPDATE
  TO authenticated
  USING (
    org_id IN (
      SELECT p.org_id FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'ORG_ADMIN'
    )
  )
  WITH CHECK (
    org_id IN (
      SELECT p.org_id FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'ORG_ADMIN'
    )
  );

-- ORG_ADMIN users can delete templates for their org
CREATE POLICY credential_templates_delete ON credential_templates
  FOR DELETE
  TO authenticated
  USING (
    org_id IN (
      SELECT p.org_id FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'ORG_ADMIN'
    )
  );

-- ROLLBACK:
-- DROP TABLE IF EXISTS credential_templates CASCADE;
