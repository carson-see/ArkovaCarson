-- BETA-08: System credential templates
-- Adds is_system flag, makes org_id nullable for system templates,
-- seeds default system templates, updates RLS for public read.

-- 1. Add is_system column
ALTER TABLE credential_templates ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;

-- 2. Make org_id nullable (system templates have no org)
ALTER TABLE credential_templates ALTER COLUMN org_id DROP NOT NULL;

-- 3. Drop the unique constraint that requires org_id (it will fail for NULLs)
ALTER TABLE credential_templates DROP CONSTRAINT IF EXISTS credential_templates_unique_name_per_org;

-- 4. Re-add unique constraint: system templates unique by name, org templates unique by (org_id, name)
CREATE UNIQUE INDEX IF NOT EXISTS idx_credential_templates_system_unique
  ON credential_templates (name) WHERE is_system = true;
CREATE UNIQUE INDEX IF NOT EXISTS idx_credential_templates_org_unique
  ON credential_templates (org_id, name) WHERE is_system = false AND org_id IS NOT NULL;

-- 5. Update RLS: authenticated users can read system templates
CREATE POLICY credential_templates_select_system ON credential_templates
  FOR SELECT
  TO authenticated
  USING (is_system = true);

-- 6. Seed system templates
INSERT INTO credential_templates (name, description, credential_type, is_system, default_metadata) VALUES
  ('Diploma', 'Academic diploma or degree certificate', 'DEGREE', true, '{"category": "academic"}'::jsonb),
  ('Certificate', 'Professional or achievement certificate', 'CERTIFICATE', true, '{"category": "professional"}'::jsonb),
  ('License', 'Professional or occupational license', 'LICENSE', true, '{"category": "regulatory"}'::jsonb),
  ('Transcript', 'Academic transcript or grade report', 'TRANSCRIPT', true, '{"category": "academic"}'::jsonb),
  ('Professional Credential', 'Industry certification or professional qualification', 'PROFESSIONAL', true, '{"category": "professional"}'::jsonb),
  ('General Document', 'General-purpose document verification', 'OTHER', true, '{"category": "general"}'::jsonb)
ON CONFLICT DO NOTHING;

-- ROLLBACK:
-- DELETE FROM credential_templates WHERE is_system = true;
-- DROP POLICY IF EXISTS credential_templates_select_system ON credential_templates;
-- DROP INDEX IF EXISTS idx_credential_templates_system_unique;
-- DROP INDEX IF EXISTS idx_credential_templates_org_unique;
-- ALTER TABLE credential_templates ALTER COLUMN org_id SET NOT NULL;
-- ALTER TABLE credential_templates ADD CONSTRAINT credential_templates_unique_name_per_org UNIQUE (org_id, name);
-- ALTER TABLE credential_templates DROP COLUMN IF EXISTS is_system;
