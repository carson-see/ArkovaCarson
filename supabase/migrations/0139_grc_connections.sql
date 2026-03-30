-- Migration 0139: GRC Platform Connections (CML-05)
--
-- Stores OAuth2 connections to GRC platforms (Vanta, Drata, Anecdotes).
-- Enables automated evidence push when anchors reach SECURED status.
--
-- Constitution refs:
--   - 1.2: Schema-first, RLS mandatory
--   - 1.4: OAuth tokens encrypted at rest (application-level), never exposed to browser
--
-- ROLLBACK: DROP TABLE IF EXISTS grc_sync_logs; DROP TABLE IF EXISTS grc_connections; DROP TYPE IF EXISTS grc_platform; DROP TYPE IF EXISTS grc_sync_status;

-- Platform enum
CREATE TYPE grc_platform AS ENUM ('vanta', 'drata', 'anecdotes');

-- Sync status enum
CREATE TYPE grc_sync_status AS ENUM ('pending', 'syncing', 'success', 'failed');

-- GRC connections table
CREATE TABLE grc_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  platform grc_platform NOT NULL,
  -- OAuth2 credentials (encrypted at application level before storage)
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expires_at TIMESTAMPTZ,
  -- Platform-specific external IDs
  external_org_id TEXT,
  external_workspace_id TEXT,
  -- Connection metadata
  scopes TEXT[] DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_sync_at TIMESTAMPTZ,
  last_sync_status grc_sync_status,
  last_sync_error TEXT,
  sync_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL REFERENCES auth.users(id),
  -- One active connection per platform per org
  CONSTRAINT uq_grc_org_platform UNIQUE (org_id, platform)
);

-- Sync log for audit trail
CREATE TABLE grc_sync_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES grc_connections(id) ON DELETE CASCADE,
  anchor_id UUID REFERENCES anchors(id) ON DELETE SET NULL,
  status grc_sync_status NOT NULL DEFAULT 'pending',
  evidence_type TEXT NOT NULL DEFAULT 'anchor_secured',
  external_evidence_id TEXT,
  error_message TEXT,
  request_payload JSONB,
  response_payload JSONB,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_grc_connections_org ON grc_connections(org_id);
CREATE INDEX idx_grc_connections_active ON grc_connections(is_active) WHERE is_active = true;
CREATE INDEX idx_grc_sync_logs_connection ON grc_sync_logs(connection_id);
CREATE INDEX idx_grc_sync_logs_anchor ON grc_sync_logs(anchor_id) WHERE anchor_id IS NOT NULL;
CREATE INDEX idx_grc_sync_logs_created ON grc_sync_logs(created_at DESC);

-- RLS (Constitution 1.4)
ALTER TABLE grc_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE grc_connections FORCE ROW LEVEL SECURITY;

ALTER TABLE grc_sync_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE grc_sync_logs FORCE ROW LEVEL SECURITY;

-- Only org admins can manage GRC connections
CREATE POLICY grc_connections_select ON grc_connections
  FOR SELECT TO authenticated
  USING (org_id IN (
    SELECT om.org_id FROM org_members om
    WHERE om.user_id = auth.uid() AND om.role IN ('owner', 'admin')
  ));

CREATE POLICY grc_connections_insert ON grc_connections
  FOR INSERT TO authenticated
  WITH CHECK (org_id IN (
    SELECT om.org_id FROM org_members om
    WHERE om.user_id = auth.uid() AND om.role IN ('owner', 'admin')
  ));

CREATE POLICY grc_connections_update ON grc_connections
  FOR UPDATE TO authenticated
  USING (org_id IN (
    SELECT om.org_id FROM org_members om
    WHERE om.user_id = auth.uid() AND om.role IN ('owner', 'admin')
  ));

CREATE POLICY grc_connections_delete ON grc_connections
  FOR DELETE TO authenticated
  USING (org_id IN (
    SELECT om.org_id FROM org_members om
    WHERE om.user_id = auth.uid() AND om.role IN ('owner', 'admin')
  ));

-- Sync logs visible to org admins
CREATE POLICY grc_sync_logs_select ON grc_sync_logs
  FOR SELECT TO authenticated
  USING (connection_id IN (
    SELECT gc.id FROM grc_connections gc
    JOIN org_members om ON gc.org_id = om.org_id
    WHERE om.user_id = auth.uid() AND om.role IN ('owner', 'admin')
  ));

-- Service role can insert sync logs (worker-only)
CREATE POLICY grc_sync_logs_service ON grc_sync_logs
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- Service role full access for worker operations
CREATE POLICY grc_connections_service ON grc_connections
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- Grant access
GRANT SELECT, INSERT, UPDATE, DELETE ON grc_connections TO authenticated;
GRANT SELECT ON grc_sync_logs TO authenticated;
GRANT ALL ON grc_connections TO service_role;
GRANT ALL ON grc_sync_logs TO service_role;

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_grc_connections_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER grc_connections_updated_at
  BEFORE UPDATE ON grc_connections
  FOR EACH ROW
  EXECUTE FUNCTION update_grc_connections_updated_at();
