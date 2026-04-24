ALTER TABLE anchors ADD COLUMN IF NOT EXISTS directory_info_opt_out boolean NOT NULL DEFAULT false;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS directory_info_fields text[] NOT NULL DEFAULT ARRAY['name','degree_type','dates_of_attendance','enrollment_status','honors']::text[],
  ADD COLUMN IF NOT EXISTS hipaa_mfa_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS session_timeout_minutes integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS emergency_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  grantee_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  approver_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reason text NOT NULL,
  scope text NOT NULL DEFAULT 'healthcare_credentials',
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_emergency_access_org ON emergency_access_grants(org_id);
CREATE INDEX IF NOT EXISTS idx_emergency_access_grantee ON emergency_access_grants(grantee_id);
CREATE INDEX IF NOT EXISTS idx_emergency_access_active ON emergency_access_grants(expires_at) WHERE revoked_at IS NULL;

ALTER TABLE emergency_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE emergency_access_grants FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS emergency_access_select ON emergency_access_grants;
CREATE POLICY emergency_access_select ON emergency_access_grants FOR SELECT
  USING (org_id IN (SELECT om.org_id FROM org_members om WHERE om.user_id = auth.uid() AND om.role IN ('owner','admin')));

DROP POLICY IF EXISTS emergency_access_insert ON emergency_access_grants;
CREATE POLICY emergency_access_insert ON emergency_access_grants FOR INSERT
  WITH CHECK (get_caller_role() = 'service_role');

DROP POLICY IF EXISTS emergency_access_update ON emergency_access_grants;
CREATE POLICY emergency_access_update ON emergency_access_grants FOR UPDATE
  USING (get_caller_role() = 'service_role');;
