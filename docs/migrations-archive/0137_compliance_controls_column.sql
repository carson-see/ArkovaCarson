-- Migration 0137: Add compliance_controls column to anchors (CML-02)
--
-- Stores regulatory control IDs (SOC 2, GDPR, FERPA, ISO 27001, eIDAS, HIPAA)
-- as an additive nullable JSONB array. Auto-populated by worker during anchoring.
--
-- Constitution 1.8: Additive nullable field — no breaking change to frozen schema.
--
-- ROLLBACK: ALTER TABLE anchors DROP COLUMN IF EXISTS compliance_controls;

ALTER TABLE anchors
  ADD COLUMN IF NOT EXISTS compliance_controls jsonb;

COMMENT ON COLUMN anchors.compliance_controls IS
  'Array of regulatory control IDs applicable to this anchor (CML-02). Auto-populated on SECURED. Example: ["SOC2-CC6.1","GDPR-5.1f","FERPA-99.31"]';

-- GIN index for querying by specific controls
CREATE INDEX IF NOT EXISTS idx_anchors_compliance_controls
  ON anchors USING GIN(compliance_controls)
  WHERE compliance_controls IS NOT NULL;
