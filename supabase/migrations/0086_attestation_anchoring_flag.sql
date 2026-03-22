-- Migration 0086: Add ENABLE_ATTESTATION_ANCHORING switchboard flag
-- Enables the attestation anchoring cron job to batch-anchor PENDING attestations to Bitcoin.
--
-- ROLLBACK: DELETE FROM switchboard_flags WHERE key = 'ENABLE_ATTESTATION_ANCHORING';

INSERT INTO switchboard_flags (key, value, description)
VALUES (
  'ENABLE_ATTESTATION_ANCHORING',
  'true',
  'Gate attestation anchoring job — when enabled, PENDING attestations are Merkle-batched and anchored to Bitcoin'
)
ON CONFLICT (key) DO NOTHING;
