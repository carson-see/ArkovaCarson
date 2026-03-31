-- VAI-02: ZK-STARK Evidence Packages — Add ZK proof columns to extraction_manifests
-- Additive nullable columns (Constitution 1.8 — frozen schema compliant)
-- PLONK zero-knowledge proofs binding AI extractions to source documents

ALTER TABLE extraction_manifests
  ADD COLUMN IF NOT EXISTS zk_proof jsonb,
  ADD COLUMN IF NOT EXISTS zk_public_signals jsonb,
  ADD COLUMN IF NOT EXISTS zk_proof_protocol text,
  ADD COLUMN IF NOT EXISTS zk_circuit_version text,
  ADD COLUMN IF NOT EXISTS zk_poseidon_hash char(64),
  ADD COLUMN IF NOT EXISTS zk_proof_generated_at timestamptz,
  ADD COLUMN IF NOT EXISTS zk_proof_generation_ms integer;

-- Index: query manifests with/without proofs
CREATE INDEX IF NOT EXISTS idx_extraction_manifests_zk_proof_status
  ON extraction_manifests ((zk_proof IS NOT NULL));

-- Index: lookup by Poseidon hash for ZK verification
CREATE INDEX IF NOT EXISTS idx_extraction_manifests_poseidon_hash
  ON extraction_manifests(zk_poseidon_hash)
  WHERE zk_poseidon_hash IS NOT NULL;

-- ROLLBACK:
-- ALTER TABLE extraction_manifests
--   DROP COLUMN IF EXISTS zk_proof,
--   DROP COLUMN IF EXISTS zk_public_signals,
--   DROP COLUMN IF EXISTS zk_proof_protocol,
--   DROP COLUMN IF EXISTS zk_circuit_version,
--   DROP COLUMN IF EXISTS zk_poseidon_hash,
--   DROP COLUMN IF EXISTS zk_proof_generated_at,
--   DROP COLUMN IF EXISTS zk_proof_generation_ms;
-- DROP INDEX IF EXISTS idx_extraction_manifests_zk_proof_status;
-- DROP INDEX IF EXISTS idx_extraction_manifests_poseidon_hash;
