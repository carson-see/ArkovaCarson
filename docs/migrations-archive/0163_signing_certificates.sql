-- Migration 0160: Signing Certificates (Phase III — PH3-ESIG-01)
-- PKI certificate chain management for AdES signature engine.
-- HSM-backed key storage — private key material never persisted in DB.
--
-- ROLLBACK: DROP TABLE IF EXISTS signing_certificates;

CREATE TABLE signing_certificates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id),

  -- Certificate metadata
  subject_cn      text NOT NULL,                            -- Common Name
  subject_org     text,                                     -- Organization
  issuer_cn       text NOT NULL,                            -- Issuer Common Name
  issuer_org      text,                                     -- Issuer Organization
  serial_number   text NOT NULL,                            -- hex-encoded serial
  fingerprint_sha256 text NOT NULL,                         -- cert fingerprint for lookups

  -- Certificate data
  certificate_pem text NOT NULL,                            -- PEM-encoded X.509 certificate
  chain_pem       text[],                                   -- intermediate certs (PEM array)

  -- Key reference (HSM-backed, never raw key material)
  kms_provider    text NOT NULL CHECK (kms_provider IN ('aws_kms', 'gcp_kms')),
  kms_key_id      text NOT NULL,                            -- KMS key ARN or resource path
  key_algorithm   text NOT NULL,                            -- RSA-2048, RSA-4096, ECDSA-P256, ECDSA-P384

  -- Validity
  not_before      timestamptz NOT NULL,
  not_after       timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE', 'EXPIRED', 'REVOKED', 'SUSPENDED')),

  -- Trust level
  trust_level     text NOT NULL DEFAULT 'ADVANCED'
                  CHECK (trust_level IN ('BASIC', 'ADVANCED', 'QUALIFIED')),
  qtsp_name       text,                                     -- QTSP name if qualified cert
  eu_trusted_list_entry text,                               -- EUTL reference if applicable

  -- Audit
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL REFERENCES auth.users(id),
  metadata        jsonb DEFAULT '{}'::jsonb,

  CONSTRAINT signing_certs_unique_per_org
    UNIQUE (org_id, fingerprint_sha256)
);

-- Indexes
CREATE INDEX idx_signing_certs_org ON signing_certificates(org_id);
CREATE INDEX idx_signing_certs_status ON signing_certificates(status);
CREATE INDEX idx_signing_certs_not_after ON signing_certificates(not_after);

-- RLS
ALTER TABLE signing_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE signing_certificates FORCE ROW LEVEL SECURITY;

-- Members can view their org's certificates
CREATE POLICY signing_certs_select ON signing_certificates FOR SELECT
  USING (org_id IN (
    SELECT om.org_id FROM org_members om WHERE om.user_id = auth.uid()
  ));

-- Only owners/admins can add certificates
CREATE POLICY signing_certs_insert ON signing_certificates FOR INSERT
  WITH CHECK (org_id IN (
    SELECT om.org_id FROM org_members om
    WHERE om.user_id = auth.uid() AND om.role IN ('owner', 'admin')
  ));

-- Only owners/admins can update certificate status
CREATE POLICY signing_certs_update ON signing_certificates FOR UPDATE
  USING (org_id IN (
    SELECT om.org_id FROM org_members om
    WHERE om.user_id = auth.uid() AND om.role IN ('owner', 'admin')
  ));

-- Service role full access
CREATE POLICY signing_certs_service ON signing_certificates FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Grant access to authenticated role
GRANT SELECT, INSERT, UPDATE ON signing_certificates TO authenticated;
GRANT ALL ON signing_certificates TO service_role;
