-- Migration 0083: Attestations (Phase II)
-- Immutable third-party attestations anchored to Bitcoin.
-- Extends credential verification into institutional attestations,
-- supply chain proofs, audit verification, and compliance use cases.
--
-- ROLLBACK: DROP TABLE IF EXISTS attestation_evidence; DROP TABLE IF EXISTS attestations; DROP TYPE IF EXISTS attestation_type; DROP TYPE IF EXISTS attester_type; DROP TYPE IF EXISTS attestation_status;

-- Attestation type enum
CREATE TYPE attestation_type AS ENUM (
  'VERIFICATION',      -- Third party verified a credential is authentic
  'ENDORSEMENT',       -- Third party endorses holder's qualification
  'AUDIT',             -- Third party conducted audit of credential/process
  'APPROVAL',          -- Regulatory or institutional approval
  'WITNESS',           -- Third party witnessed credential presentation
  'COMPLIANCE',        -- Compliance attestation (SOX, ESG, regulatory)
  'SUPPLY_CHAIN',      -- Supply chain provenance attestation
  'IDENTITY',          -- Identity verification attestation
  'CUSTOM'             -- Custom attestation type
);

-- Attester type enum
CREATE TYPE attester_type AS ENUM (
  'INSTITUTION',       -- University, regulatory body, etc.
  'CORPORATION',       -- Company making attestation
  'INDIVIDUAL',        -- Licensed professional (lawyer, CPA, notary)
  'REGULATORY',        -- Government or regulatory body
  'THIRD_PARTY'        -- Independent verification service
);

-- Attestation status enum
CREATE TYPE attestation_status AS ENUM (
  'DRAFT',             -- Created but not yet submitted for anchoring
  'PENDING',           -- Submitted, awaiting Bitcoin anchoring
  'ACTIVE',            -- Anchored and valid
  'REVOKED',           -- Revoked by attester
  'EXPIRED',           -- Past expiry date
  'CHALLENGED'         -- Challenged by a third party
);

-- Main attestations table
CREATE TABLE attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Identity
  public_id text NOT NULL UNIQUE,
  -- What is being attested
  anchor_id uuid REFERENCES anchors(id),           -- Optional: link to existing credential
  subject_type text NOT NULL DEFAULT 'credential',  -- 'credential', 'entity', 'process', 'asset'
  subject_identifier text NOT NULL,                 -- Public ID, entity name, or description
  -- Who is attesting
  attester_org_id uuid REFERENCES organizations(id),
  attester_user_id uuid NOT NULL,
  attester_name text NOT NULL,
  attester_type attester_type NOT NULL DEFAULT 'INSTITUTION',
  attester_title text,                              -- "General Counsel", "Compliance Officer", etc.
  -- The attestation itself
  attestation_type attestation_type NOT NULL,
  claims jsonb NOT NULL DEFAULT '[]'::jsonb,        -- [{claim: string, evidence?: string}]
  summary text,                                     -- Human-readable summary of attestation
  jurisdiction text,                                -- Jurisdiction context
  -- Evidence
  evidence_fingerprint text,                        -- SHA-256 of supporting documentation
  -- Status & lifecycle
  status attestation_status NOT NULL DEFAULT 'DRAFT',
  -- Chain proof (populated after anchoring)
  fingerprint text,                                 -- SHA-256 of the attestation content
  chain_tx_id text,
  chain_block_height int,
  chain_timestamp timestamptz,
  -- Timestamps
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,                           -- Nullable: some attestations don't expire
  revoked_at timestamptz,
  revocation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Metadata
  metadata jsonb DEFAULT '{}'::jsonb
);

-- Indexes
CREATE INDEX idx_attestations_public_id ON attestations(public_id);
CREATE INDEX idx_attestations_anchor_id ON attestations(anchor_id) WHERE anchor_id IS NOT NULL;
CREATE INDEX idx_attestations_attester_org ON attestations(attester_org_id) WHERE attester_org_id IS NOT NULL;
CREATE INDEX idx_attestations_attester_user ON attestations(attester_user_id);
CREATE INDEX idx_attestations_status ON attestations(status);
CREATE INDEX idx_attestations_type ON attestations(attestation_type);
CREATE INDEX idx_attestations_subject ON attestations(subject_identifier);
CREATE INDEX idx_attestations_created ON attestations(created_at DESC);

-- RLS
ALTER TABLE attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE attestations FORCE ROW LEVEL SECURITY;

-- Users can read attestations they created or that are linked to their org's anchors
CREATE POLICY attestations_select ON attestations FOR SELECT USING (
  attester_user_id = auth.uid()
  OR attester_org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  OR anchor_id IN (SELECT id FROM anchors WHERE user_id = auth.uid())
  OR status = 'ACTIVE'  -- Active attestations are publicly readable
);

-- Users can insert attestations for their own org
CREATE POLICY attestations_insert ON attestations FOR INSERT WITH CHECK (
  attester_user_id = auth.uid()
);

-- Users can update their own attestations (status changes only)
CREATE POLICY attestations_update ON attestations FOR UPDATE USING (
  attester_user_id = auth.uid()
);

-- Service role bypasses RLS for worker operations
GRANT ALL ON attestations TO service_role;

-- Evidence table for supporting documents
CREATE TABLE attestation_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attestation_id uuid NOT NULL REFERENCES attestations(id) ON DELETE CASCADE,
  evidence_type text NOT NULL DEFAULT 'document',   -- 'document', 'letter', 'report', 'assessment'
  fingerprint text NOT NULL,                         -- SHA-256 of evidence doc
  filename text,
  description text,
  uploaded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_evidence_attestation ON attestation_evidence(attestation_id);

ALTER TABLE attestation_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE attestation_evidence FORCE ROW LEVEL SECURITY;

CREATE POLICY evidence_select ON attestation_evidence FOR SELECT USING (
  attestation_id IN (SELECT id FROM attestations WHERE attester_user_id = auth.uid()
    OR attester_org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
    OR status = 'ACTIVE')
);

CREATE POLICY evidence_insert ON attestation_evidence FOR INSERT WITH CHECK (
  uploaded_by = auth.uid()
);

GRANT ALL ON attestation_evidence TO service_role;

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_attestation_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER attestations_updated_at
  BEFORE UPDATE ON attestations
  FOR EACH ROW EXECUTE FUNCTION update_attestation_updated_at();

-- Immutability: claims cannot be modified after status leaves DRAFT
CREATE OR REPLACE FUNCTION prevent_attestation_claim_modification()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status != 'DRAFT' AND NEW.claims IS DISTINCT FROM OLD.claims THEN
    RAISE EXCEPTION 'Attestation claims cannot be modified after submission'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER attestations_immutable_claims
  BEFORE UPDATE ON attestations
  FOR EACH ROW EXECUTE FUNCTION prevent_attestation_claim_modification();
