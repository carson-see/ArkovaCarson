-- Migration: REG-02 Directory Information Opt-Out + REG-05/06 Org HIPAA Settings
-- REG-02: FERPA Section 99.37 — students can opt out of directory information disclosure
-- REG-05: HIPAA MFA enforcement flag per organization
-- REG-06: HIPAA session timeout setting per organization

-- ─── REG-02: Directory Info Opt-Out ─────────────────────────────────────────

-- Per-anchor opt-out flag (recipient-level, per institution)
ALTER TABLE anchors
  ADD COLUMN IF NOT EXISTS directory_info_opt_out boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN anchors.directory_info_opt_out IS 'FERPA Section 99.37 — when true, directory-level fields (name, degree type, dates) are suppressed in verification API responses';

-- Institution-configurable: which metadata fields count as "directory information"
-- Default FERPA directory info fields per 34 CFR 99.3
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS directory_info_fields text[] NOT NULL DEFAULT ARRAY['name', 'degree_type', 'dates_of_attendance', 'enrollment_status', 'honors']::text[];

COMMENT ON COLUMN organizations.directory_info_fields IS 'Institution-configurable list of metadata fields classified as FERPA directory information (vs. education records)';

-- ─── REG-05: HIPAA MFA Enforcement ──────────────────────────────────────────

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS hipaa_mfa_required boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN organizations.hipaa_mfa_required IS 'When true, MFA is enforced for users accessing healthcare credential types (INSURANCE, MEDICAL_LICENSE, etc.)';

-- ─── REG-06: HIPAA Session Timeout ──────────────────────────────────────────

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS session_timeout_minutes integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN organizations.session_timeout_minutes IS 'Inactivity timeout in minutes. 0 = disabled. HIPAA orgs should set to 15. Section 164.312(a)(2)(iii)';

-- ─── REG-10: Emergency Access Grants ────────────────────────────────────────

CREATE TABLE emergency_access_grants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  grantee_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  approver_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reason          text NOT NULL,
  scope           text NOT NULL DEFAULT 'healthcare_credentials',
  granted_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  revoke_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_emergency_access_org ON emergency_access_grants(org_id);
CREATE INDEX idx_emergency_access_grantee ON emergency_access_grants(grantee_id);
CREATE INDEX idx_emergency_access_active ON emergency_access_grants(expires_at) WHERE revoked_at IS NULL;

ALTER TABLE emergency_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE emergency_access_grants FORCE ROW LEVEL SECURITY;

-- Org admins can view their org's grants
CREATE POLICY emergency_access_select ON emergency_access_grants
  FOR SELECT
  USING (
    org_id IN (
      SELECT om.org_id FROM org_members om
      WHERE om.user_id = auth.uid()
      AND om.role IN ('owner', 'admin')
    )
  );

-- Only service_role can insert/update (worker-managed)
CREATE POLICY emergency_access_insert ON emergency_access_grants
  FOR INSERT
  WITH CHECK (get_caller_role() = 'service_role');

CREATE POLICY emergency_access_update ON emergency_access_grants
  FOR UPDATE
  USING (get_caller_role() = 'service_role');

COMMENT ON TABLE emergency_access_grants IS 'HIPAA Section 164.312(a)(2)(ii) — time-limited emergency access grants with dual-control approval';

-- ROLLBACK:
-- ALTER TABLE anchors DROP COLUMN IF EXISTS directory_info_opt_out;
-- ALTER TABLE organizations DROP COLUMN IF EXISTS directory_info_fields;
-- ALTER TABLE organizations DROP COLUMN IF EXISTS hipaa_mfa_required;
-- ALTER TABLE organizations DROP COLUMN IF EXISTS session_timeout_minutes;
-- DROP TABLE IF EXISTS emergency_access_grants CASCADE;
