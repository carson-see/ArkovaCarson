-- Migration: Reset all signet anchors for mainnet re-anchoring
--
-- Context: All 50,000+ anchors were created on Bitcoin signet (test network).
-- Now that production is switching to mainnet, every anchor must be re-anchored.
-- This migration:
--   1. Stores the old signet tx_id in metadata.signet_tx_id for audit trail
--   2. Resets all non-REVOKED anchors to PENDING status
--   3. Clears chain_tx_id so the batch-anchor job picks them up
--   4. The existing processBatchAnchors() cron (every 5 min, 10,000/TX)
--      will automatically re-anchor them on mainnet in batches.
--
-- At 10,000 per TX and 50,000+ anchors, this will take ~5 batches / ~25 minutes.
--
-- ROLLBACK: UPDATE anchors SET status = (metadata->>'signet_status')::anchor_status,
--           chain_tx_id = metadata->>'signet_tx_id' WHERE metadata ? 'signet_tx_id';

-- Step 1: Store old signet data in metadata before clearing
UPDATE anchors
SET metadata = COALESCE(metadata, '{}'::jsonb)
  || jsonb_build_object(
    'signet_tx_id', COALESCE(chain_tx_id, ''),
    'signet_status', status::text,
    'signet_migration_at', now()::text
  )
WHERE status != 'REVOKED'
  AND deleted_at IS NULL;

-- Step 2: Reset all non-REVOKED anchors to PENDING for re-anchoring
-- Clear chain fields so batch-anchor picks them up fresh
UPDATE anchors
SET
  status = 'PENDING',
  chain_tx_id = NULL,
  chain_block_height = NULL,
  chain_timestamp = NULL,
  updated_at = now()
WHERE status != 'REVOKED'
  AND deleted_at IS NULL;

-- Step 3: Clear the anchor_chain_index (signet data no longer valid)
DELETE FROM anchor_chain_index
WHERE TRUE;

-- Step 4: Clear merkle_batches (signet batches no longer valid)
DELETE FROM merkle_batches
WHERE TRUE;

-- Step 5: Log the migration event
INSERT INTO audit_events (event_type, target_type, details)
VALUES (
  'SYSTEM_MIGRATION',
  'ANCHOR',
  jsonb_build_object(
    'migration', '0123_reset_signet_anchors_for_mainnet',
    'action', 'Reset all signet anchors to PENDING for mainnet re-anchoring',
    'timestamp', now()::text
  )
);
