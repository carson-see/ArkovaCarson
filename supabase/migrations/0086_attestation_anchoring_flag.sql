-- Migration 0086: Add ENABLE_ATTESTATION_ANCHORING switchboard flag
-- Enables the attestation anchoring cron job to batch-anchor PENDING attestations to Bitcoin.
--
-- ROLLBACK: DELETE FROM switchboard_flags WHERE id = 'ENABLE_ATTESTATION_ANCHORING';

INSERT INTO switchboard_flags (id, value, default_value, description, is_dangerous)
VALUES (
  'ENABLE_ATTESTATION_ANCHORING',
  true,
  true,
  'Gate attestation anchoring job — when enabled, PENDING attestations are Merkle-batched and anchored to Bitcoin',
  false
)
ON CONFLICT (id) DO NOTHING;
