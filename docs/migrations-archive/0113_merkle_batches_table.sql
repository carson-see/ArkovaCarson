-- BTC-001: Merkle Batches tracking table
-- Records each batch anchor transaction with its Merkle root and leaf count.
-- Enables batch-level queries and audit trail for anchoring operations.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS merkle_batches;

CREATE TABLE IF NOT EXISTS merkle_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id TEXT NOT NULL UNIQUE,
  merkle_root TEXT NOT NULL,
  tx_hash TEXT,
  leaf_count INT NOT NULL DEFAULT 0,
  fee_sats INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ
);

-- Index for looking up batches by merkle_root (verification queries)
CREATE INDEX idx_merkle_batches_root ON merkle_batches (merkle_root);

-- Index for chronological queries
CREATE INDEX idx_merkle_batches_created ON merkle_batches (created_at);

-- RLS: service_role only (worker manages batches)
ALTER TABLE merkle_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE merkle_batches FORCE ROW LEVEL SECURITY;

-- Admin read-only policy for platform admins
CREATE POLICY merkle_batches_admin_read ON merkle_batches
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_platform_admin = true
    )
  );

COMMENT ON TABLE merkle_batches IS 'BTC-001: Tracks Merkle tree batch anchor transactions';
