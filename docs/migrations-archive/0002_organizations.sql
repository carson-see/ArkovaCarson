-- Migration: 0002_organizations.sql
-- Description: Create organizations table for multi-tenant support
-- Rollback: DROP TABLE IF EXISTS organizations; DROP FUNCTION IF EXISTS trigger_set_updated_at();

-- Reusable trigger function for updated_at timestamps
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Organizations table
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name text NOT NULL,
  display_name text NOT NULL,
  domain text NULL,
  verification_status text NOT NULL DEFAULT 'UNVERIFIED',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Constraints
  CONSTRAINT organizations_legal_name_length CHECK (char_length(legal_name) >= 1 AND char_length(legal_name) <= 255),
  CONSTRAINT organizations_display_name_length CHECK (char_length(display_name) >= 1 AND char_length(display_name) <= 255),
  CONSTRAINT organizations_domain_format CHECK (domain IS NULL OR domain ~ '^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$'),
  CONSTRAINT organizations_verification_status_valid CHECK (verification_status IN ('UNVERIFIED', 'PENDING', 'VERIFIED'))
);

-- Indexes
CREATE INDEX idx_organizations_domain ON organizations(domain) WHERE domain IS NOT NULL;
CREATE INDEX idx_organizations_created_at ON organizations(created_at);

-- Trigger for updated_at
CREATE TRIGGER set_organizations_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

-- Comments
COMMENT ON TABLE organizations IS 'Tenant organizations for multi-tenant isolation';
COMMENT ON COLUMN organizations.legal_name IS 'Official legal name of the organization';
COMMENT ON COLUMN organizations.display_name IS 'Display name shown in UI';
COMMENT ON COLUMN organizations.domain IS 'Organization domain (lowercase, validated format)';
COMMENT ON COLUMN organizations.verification_status IS 'Organization verification state: UNVERIFIED, PENDING, VERIFIED';
