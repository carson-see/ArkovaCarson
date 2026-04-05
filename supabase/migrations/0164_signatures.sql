-- Migration 0161: Signatures table (Phase III — PH3-ESIG-01)
-- Core AdES signature records linking anchors/attestations to legally binding e-signatures.
-- Supports XAdES, PAdES, CAdES at all ETSI baseline levels (B-B, B-T, B-LT, B-LTA).
--
-- ROLLBACK: DROP TABLE IF EXISTS signatures;

CREATE TABLE signatures (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text NOT NULL UNIQUE,                     -- ARK-{org}-SIG-{unique}
  org_id          uuid NOT NULL REFERENCES organizations(id),
  anchor_id       uuid REFERENCES anchors(id),              -- link to existing anchor
  attestation_id  uuid REFERENCES attestations(id),         -- optional link to attestation

  -- Signature metadata
  format          text NOT NULL CHECK (format IN ('XAdES', 'PAdES', 'CAdES')),
  level           text NOT NULL CHECK (level IN ('B-B', 'B-T', 'B-LT', 'B-LTA')),
  status          text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'SIGNED', 'TIMESTAMPED', 'LTV_EMBEDDED', 'COMPLETE', 'FAILED', 'REVOKED')),
  jurisdiction    text CHECK (jurisdiction IN ('EU', 'US', 'UK', 'CH', 'INTL')),

  -- Fingerprint (matches anchor fingerprint)
  document_fingerprint  text NOT NULL,

  -- Signer info
  signer_certificate_id uuid NOT NULL REFERENCES signing_certificates(id),
  signer_name           text,                               -- display name from cert CN
  signer_org            text,                               -- display name from cert O

  -- Signature data (stored as base64)
  signature_value       text,                               -- the cryptographic signature
  signed_attributes     jsonb,                              -- what was signed (hash, timestamp, cert digest)
  signature_algorithm   text,                               -- e.g., 'sha256WithRSAEncryption', 'ecdsa-with-SHA256'

  -- Timestamp token reference (populated for B-T and above)
  timestamp_token_id    uuid,                               -- FK added after timestamp_tokens table

  -- LTV data
  ltv_data_embedded     boolean NOT NULL DEFAULT false,
  archive_timestamp_id  uuid,                               -- FK added after timestamp_tokens table

  -- Metadata
  reason          text,                                      -- signing reason (e.g., "Contract approval")
  location        text,                                      -- signing location
  contact_info    text,                                      -- signer contact

  -- Audit
  created_at      timestamptz NOT NULL DEFAULT now(),
  signed_at       timestamptz,
  completed_at    timestamptz,
  revoked_at      timestamptz,
  revocation_reason text,
  created_by      uuid NOT NULL REFERENCES auth.users(id),
  metadata        jsonb DEFAULT '{}'::jsonb,

  -- Must reference either an anchor or an attestation
  CONSTRAINT signatures_anchor_or_attestation
    CHECK (anchor_id IS NOT NULL OR attestation_id IS NOT NULL)
);

-- Indexes
CREATE INDEX idx_signatures_org_id ON signatures(org_id);
CREATE INDEX idx_signatures_anchor_id ON signatures(anchor_id);
CREATE INDEX idx_signatures_attestation_id ON signatures(attestation_id);
CREATE INDEX idx_signatures_status ON signatures(status);
CREATE INDEX idx_signatures_created_at ON signatures(created_at DESC);
CREATE INDEX idx_signatures_signer_cert ON signatures(signer_certificate_id);
CREATE INDEX idx_signatures_public_id ON signatures(public_id);

-- RLS
ALTER TABLE signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE signatures FORCE ROW LEVEL SECURITY;

-- Members can view their org's signatures
CREATE POLICY signatures_select ON signatures FOR SELECT
  USING (org_id IN (
    SELECT om.org_id FROM org_members om WHERE om.user_id = auth.uid()
  ));

-- Only owners/admins can create signatures
CREATE POLICY signatures_insert ON signatures FOR INSERT
  WITH CHECK (org_id IN (
    SELECT om.org_id FROM org_members om
    WHERE om.user_id = auth.uid() AND om.role IN ('owner', 'admin')
  ));

-- Only owners/admins can update (status transitions)
CREATE POLICY signatures_update ON signatures FOR UPDATE
  USING (org_id IN (
    SELECT om.org_id FROM org_members om
    WHERE om.user_id = auth.uid() AND om.role IN ('owner', 'admin')
  ));

-- Service role full access (worker writes signature data)
CREATE POLICY signatures_service ON signatures FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Grant access
GRANT SELECT, INSERT, UPDATE ON signatures TO authenticated;
GRANT ALL ON signatures TO service_role;
