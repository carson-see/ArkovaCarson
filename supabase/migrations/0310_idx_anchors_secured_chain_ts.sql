-- ROLLBACK: DROP INDEX IF EXISTS idx_anchors_secured_chain_ts;
--
-- Add partial index on anchors for chain_timestamp queries filtered by
-- status = 'SECURED'. Without this index, the query in anchor-stats.ts
-- that fetches the latest secured chain_timestamp does a full sort of
-- ~3M rows (EXPLAIN cost: 1,691,446) and times out.
--
-- The partial index covers only SECURED rows with non-null deleted_at,
-- matching the WHERE clause used by fetchAnchorStats() in
-- services/worker/src/utils/anchor-stats.ts.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_secured_chain_ts
  ON public.anchors (chain_timestamp DESC NULLS LAST)
  WHERE status = 'SECURED' AND deleted_at IS NULL;
