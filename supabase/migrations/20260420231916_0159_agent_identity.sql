DO $$ BEGIN
  CREATE TYPE agent_type AS ENUM ('llm_agent', 'ats_integration', 'hr_platform', 'compliance_tool', 'custom');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE agent_status AS ENUM ('active', 'suspended', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  agent_type agent_type NOT NULL DEFAULT 'custom',
  status agent_status NOT NULL DEFAULT 'active',
  allowed_scopes text[] NOT NULL DEFAULT ARRAY['verify'],
  registered_by uuid NOT NULL REFERENCES auth.users(id),
  framework text,
  version text,
  callback_url text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz,
  suspended_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT agents_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT agents_callback_https CHECK (callback_url IS NULL OR callback_url LIKE 'https://%')
);

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agents_select_org ON agents;
CREATE POLICY agents_select_org ON agents FOR SELECT TO authenticated USING (org_id = get_user_org_id());

DROP POLICY IF EXISTS agents_insert_admin ON agents;
CREATE POLICY agents_insert_admin ON agents FOR INSERT TO authenticated WITH CHECK (org_id = get_user_org_id() AND is_org_admin());

DROP POLICY IF EXISTS agents_update_admin ON agents;
CREATE POLICY agents_update_admin ON agents FOR UPDATE TO authenticated USING (org_id = get_user_org_id() AND is_org_admin());

DROP POLICY IF EXISTS agents_delete_admin ON agents;
CREATE POLICY agents_delete_admin ON agents FOR DELETE TO authenticated USING (org_id = get_user_org_id() AND is_org_admin());

DROP POLICY IF EXISTS agents_service_role ON agents;
CREATE POLICY agents_service_role ON agents FOR ALL TO service_role USING (true);

CREATE INDEX IF NOT EXISTS idx_agents_org_id ON agents(org_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_agents_type ON agents(agent_type);

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES agents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_agent_id ON api_keys(agent_id) WHERE agent_id IS NOT NULL;

CREATE OR REPLACE FUNCTION update_agents_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agents_updated_at ON agents;
CREATE TRIGGER agents_updated_at BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION update_agents_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON agents TO authenticated;
GRANT ALL ON agents TO service_role;;
