-- Migration: 0106_performance_indexes.sql
-- Description: Add indexes for treasury + pipeline page performance.
-- Fixes: full table scans on 29K+ public_records and x402_payments.
-- ROLLBACK: DROP INDEX IF EXISTS idx_public_records_type_created,
--           idx_public_records_title_trgm, idx_public_records_source_created,
--           idx_public_records_anchor_id, idx_x402_payments_created,
--           idx_anchors_active_created;

-- Pipeline page: filter by record_type + sort by created_at
CREATE INDEX IF NOT EXISTS idx_public_records_type_created
ON public_records (record_type, created_at DESC);

-- Pipeline page: filter by source + sort by created_at
CREATE INDEX IF NOT EXISTS idx_public_records_source_created
ON public_records (source, created_at DESC);

-- Pipeline page: count anchored vs pending records
CREATE INDEX IF NOT EXISTS idx_public_records_anchor_id
ON public_records (anchor_id) WHERE anchor_id IS NOT NULL;

-- Pipeline page: ILIKE search on title — trigram index for fast substring matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_public_records_title_trgm
ON public_records USING gin (title gin_trgm_ops);

-- Treasury page: recent x402 payments
CREATE INDEX IF NOT EXISTS idx_x402_payments_created
ON x402_payments (created_at DESC);

-- Treasury page: recent anchors (non-deleted)
CREATE INDEX IF NOT EXISTS idx_anchors_active_created
ON anchors (created_at DESC) WHERE deleted_at IS NULL;

-- Pipeline stats RPC: single query returning all 4 counts
CREATE OR REPLACE FUNCTION get_pipeline_stats()
RETURNS json
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT json_build_object(
    'total_records', (SELECT count(*) FROM public_records),
    'anchored_records', (SELECT count(*) FROM public_records WHERE anchor_id IS NOT NULL),
    'pending_records', (SELECT count(*) FROM public_records WHERE anchor_id IS NULL),
    'embedded_records', (SELECT count(*) FROM public_record_embeddings),
    'record_types', (SELECT json_agg(DISTINCT record_type) FROM public_records)
  );
$$;

GRANT EXECUTE ON FUNCTION get_pipeline_stats() TO authenticated, service_role;

-- Treasury stats RPC: single query for x402 payment stats
CREATE OR REPLACE FUNCTION get_treasury_stats()
RETURNS json
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT json_build_object(
    'total_payments', (SELECT count(*) FROM x402_payments),
    'total_revenue_usd', (SELECT COALESCE(sum(amount_usd), 0) FROM x402_payments),
    'recent_payments', (
      SELECT json_agg(row_to_json(t))
      FROM (
        SELECT tx_hash, amount_usd, payer_address, created_at
        FROM x402_payments
        ORDER BY created_at DESC
        LIMIT 5
      ) t
    )
  );
$$;

GRANT EXECUTE ON FUNCTION get_treasury_stats() TO authenticated, service_role;
