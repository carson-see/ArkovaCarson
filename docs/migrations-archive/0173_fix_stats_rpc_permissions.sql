-- =============================================================================
-- Migration 0173: Fix stats RPC permissions
-- Date: 2026-04-07
--
-- PURPOSE
-- -------
-- Migration 0160 attempted to REVOKE PUBLIC execute on get_treasury_stats
-- and get_pipeline_stats, but the REVOKE may not have taken effect if
-- CREATE OR REPLACE silently failed (language change sql→plpgsql).
-- This migration ensures the auth-guarded versions are in place and
-- permissions are correctly restricted.
--
-- ROLLBACK: GRANT EXECUTE ON FUNCTION get_treasury_stats() TO public;
--           GRANT EXECUTE ON FUNCTION get_pipeline_stats() TO public;
-- =============================================================================

-- Ensure the auth-guarded versions exist
CREATE OR REPLACE FUNCTION get_treasury_stats()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  IF NOT (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN
    RAISE EXCEPTION 'Access denied: platform admin required';
  END IF;

  RETURN (
    SELECT json_build_object(
      'total_payments', (SELECT count(*) FROM x402_payments),
      'total_revenue_usd', (SELECT COALESCE(sum(amount_usd), 0) FROM x402_payments),
      'recent_payments', (
        SELECT json_agg(row_to_json(t))
        FROM (
          SELECT tx_hash, amount_usd, created_at
          FROM x402_payments
          ORDER BY created_at DESC
          LIMIT 5
        ) t
      )
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION get_pipeline_stats()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  IF NOT (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN
    RAISE EXCEPTION 'Access denied: platform admin required';
  END IF;

  RETURN (
    SELECT json_build_object(
      'total_records', (SELECT count(*) FROM public_records),
      'anchored_records', (SELECT count(*) FROM public_records WHERE anchor_id IS NOT NULL),
      'pending_records', (SELECT count(*) FROM public_records WHERE anchor_id IS NULL),
      'embedded_records', (SELECT count(*) FROM public_record_embeddings),
      'record_types', (SELECT json_agg(DISTINCT record_type) FROM public_records)
    )
  );
END;
$$;

-- Explicitly revoke from all non-privileged roles
REVOKE EXECUTE ON FUNCTION get_treasury_stats() FROM public, anon;
REVOKE EXECUTE ON FUNCTION get_pipeline_stats() FROM public, anon;
GRANT EXECUTE ON FUNCTION get_treasury_stats() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_pipeline_stats() TO authenticated, service_role;
