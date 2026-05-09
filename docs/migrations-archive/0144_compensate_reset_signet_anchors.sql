-- Compensating migration for deleted 0123_reset_signet_anchors_for_mainnet.sql
-- (duplicate PK with 0123_get_anchor_tx_stats_rpc.sql)
-- Resets signet anchors for mainnet re-anchoring.
-- On fresh CI DB: no-op (no anchors exist). On production: already applied.
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
  AND deleted_at IS NULL
  AND NOT (metadata ? 'signet_tx_id');

-- Step 2: Reset non-REVOKED anchors to PENDING (skip if already migrated)
UPDATE anchors
SET
  status = 'PENDING',
  chain_tx_id = NULL,
  chain_block_height = NULL,
  chain_timestamp = NULL,
  updated_at = now()
WHERE status != 'REVOKED'
  AND deleted_at IS NULL
  AND metadata ? 'signet_tx_id'
  AND NOT (metadata ? 'signet_migration_complete');

-- Step 3-4: Clear signet chain data (idempotent — deletes are safe to repeat)
DELETE FROM anchor_chain_index WHERE TRUE;
DELETE FROM merkle_batches WHERE TRUE;

-- Step 5: Log migration event
INSERT INTO audit_events (event_type, event_category, target_type, details)
VALUES (
  'SYSTEM_MIGRATION',
  'SYSTEM',
  'ANCHOR',
  jsonb_build_object(
    'migration', '0144_compensate_reset_signet_anchors',
    'action', 'Reset all signet anchors to PENDING for mainnet re-anchoring',
    'timestamp', now()::text
  )::text
);
