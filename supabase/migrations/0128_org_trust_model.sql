-- Migration: 0128_org_trust_model.sql
-- Description: Organization Trust Model (IDT WS4)
-- Adds EIN/Tax ID verification, domain verification tracking, sub-org affiliation,
-- and domain verification tokens for magic-link org domain confirmation.
-- ROLLBACK: See bottom of file.

-- ─── EIN / Tax ID for verified orgs ───────────────────────────────────
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ein_tax_id text DEFAULT NULL;

-- UNIQUE constraint for dupe protection (one org per EIN)
ALTER TABLE organizations ADD CONSTRAINT organizations_ein_unique UNIQUE (ein_tax_id);

-- EIN format: XX-XXXXXXX (US) — allow international tax IDs too (looser check)
ALTER TABLE organizations ADD CONSTRAINT organizations_ein_format CHECK (
  ein_tax_id IS NULL OR length(ein_tax_id) >= 5
);

-- ─── Domain verification ──────────────────────────────────────────────
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS domain_verified boolean DEFAULT false;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS domain_verification_method text DEFAULT NULL
  CHECK (domain_verification_method IS NULL OR domain_verification_method IN ('email', 'dns'));
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS domain_verified_at timestamptz DEFAULT NULL;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS domain_verification_token text DEFAULT NULL;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS domain_verification_token_expires_at timestamptz DEFAULT NULL;

-- ─── Sub-org affiliation model ────────────────────────────────────────
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS parent_org_id uuid DEFAULT NULL
  REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS parent_approval_status text DEFAULT NULL
  CHECK (parent_approval_status IS NULL OR parent_approval_status IN ('PENDING', 'APPROVED', 'REVOKED'));
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS parent_approved_at timestamptz DEFAULT NULL;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS max_sub_orgs integer DEFAULT NULL;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS affiliation_fee_status text DEFAULT NULL
  CHECK (affiliation_fee_status IS NULL OR affiliation_fee_status IN ('ACTIVE', 'GRACE', 'LAPSED'));
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS affiliation_grace_expires_at timestamptz DEFAULT NULL;

-- CHECK: parent org cannot itself have a parent (one level deep only)
CREATE OR REPLACE FUNCTION check_sub_org_depth()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.parent_org_id IS NOT NULL THEN
    -- Check if the proposed parent already has a parent
    IF EXISTS (
      SELECT 1 FROM organizations WHERE id = NEW.parent_org_id AND parent_org_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Sub-organizations cannot create their own sub-organizations (one level deep only)';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_check_sub_org_depth
  BEFORE INSERT OR UPDATE OF parent_org_id ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION check_sub_org_depth();

-- ─── Indexes ──────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_organizations_ein ON organizations (ein_tax_id) WHERE ein_tax_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_organizations_parent ON organizations (parent_org_id) WHERE parent_org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_organizations_domain_verified ON organizations (domain) WHERE domain_verified = true;

-- ─── Comments ─────────────────────────────────────────────────────────
COMMENT ON COLUMN organizations.ein_tax_id IS 'EIN/Tax ID for verified orgs — UNIQUE, L3 Confidential (IDT WS4)';
COMMENT ON COLUMN organizations.domain_verified IS 'Whether the org domain has been verified via email or DNS (IDT WS4)';
COMMENT ON COLUMN organizations.domain_verification_method IS 'How domain was verified: email or dns (IDT WS4)';
COMMENT ON COLUMN organizations.domain_verified_at IS 'When domain was verified (IDT WS4)';
COMMENT ON COLUMN organizations.domain_verification_token IS 'Token for email-based domain verification (IDT WS4)';
COMMENT ON COLUMN organizations.domain_verification_token_expires_at IS 'Expiry for domain verification token (IDT WS4)';
COMMENT ON COLUMN organizations.parent_org_id IS 'Parent org for sub-org affiliation — one level deep only (IDT WS4)';
COMMENT ON COLUMN organizations.parent_approval_status IS 'Sub-org approval: PENDING, APPROVED, REVOKED (IDT WS4)';
COMMENT ON COLUMN organizations.max_sub_orgs IS 'Admin-set cap on affiliated sub-orgs (IDT WS4)';

-- ROLLBACK:
-- DROP TRIGGER IF EXISTS trg_check_sub_org_depth ON organizations;
-- DROP FUNCTION IF EXISTS check_sub_org_depth();
-- ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_ein_unique;
-- ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_ein_format;
-- ALTER TABLE organizations DROP COLUMN IF EXISTS ein_tax_id;
-- ALTER TABLE organizations DROP COLUMN IF EXISTS domain_verified;
-- ALTER TABLE organizations DROP COLUMN IF EXISTS domain_verification_method;
-- ALTER TABLE organizations DROP COLUMN IF EXISTS domain_verified_at;
-- ALTER TABLE organizations DROP COLUMN IF EXISTS domain_verification_token;
-- ALTER TABLE organizations DROP COLUMN IF EXISTS domain_verification_token_expires_at;
-- ALTER TABLE organizations DROP COLUMN IF EXISTS parent_org_id;
-- ALTER TABLE organizations DROP COLUMN IF EXISTS parent_approval_status;
-- ALTER TABLE organizations DROP COLUMN IF EXISTS parent_approved_at;
-- ALTER TABLE organizations DROP COLUMN IF EXISTS max_sub_orgs;
-- ALTER TABLE organizations DROP COLUMN IF EXISTS affiliation_fee_status;
-- ALTER TABLE organizations DROP COLUMN IF EXISTS affiliation_grace_expires_at;
-- DROP INDEX IF EXISTS idx_organizations_ein;
-- DROP INDEX IF EXISTS idx_organizations_parent;
-- DROP INDEX IF EXISTS idx_organizations_domain_verified;
