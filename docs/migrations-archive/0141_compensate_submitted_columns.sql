-- Compensating migration for 0068b_submitted_status_and_confirmations.sql
-- (skipped by CLI — non-numeric prefix)
-- Adds columns that were originally in 0068b. All use IF NOT EXISTS for idempotency.
-- Does NOT recreate protect_anchor_status_transition() — later migrations (0125) already define it.
-- ROLLBACK: ALTER TABLE anchors DROP COLUMN IF EXISTS chain_confirmations;
--           ALTER TABLE anchors DROP COLUMN IF EXISTS revocation_tx_id;
--           ALTER TABLE anchors DROP COLUMN IF EXISTS revocation_block_height;
--           ALTER TABLE anchors DROP COLUMN IF EXISTS description;
--           DROP INDEX IF EXISTS idx_anchors_submitted_status;

ALTER TABLE anchors ADD COLUMN IF NOT EXISTS chain_confirmations INTEGER DEFAULT 0;
ALTER TABLE anchors ADD COLUMN IF NOT EXISTS revocation_tx_id TEXT;
ALTER TABLE anchors ADD COLUMN IF NOT EXISTS revocation_block_height INTEGER;
ALTER TABLE anchors ADD COLUMN IF NOT EXISTS description TEXT;

CREATE INDEX IF NOT EXISTS idx_anchors_submitted_status
  ON anchors (status) WHERE status = 'SUBMITTED';
