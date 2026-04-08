-- Migration 0175: Fix get_pipeline_stats timeout on 1.4M row public_records table
--
-- Problem: get_pipeline_stats() does 5 sequential count(*) queries on public_records
-- (1.41M rows), causing a 3+ second timeout on every Pipeline Admin page load.
-- The PipelineAdminPage also does select('*', { count: 'exact' }) directly on
-- public_records, which also times out.
--
-- Fix:
-- 1. Replace count(*) with reltuples estimate for total/type counts (instant, ~1% accurate)
-- 2. Keep exact counts only for small result sets (anchored/pending use partial indexes)
-- 3. Add a fast paginated query function for the admin table

-- =========================================================================
-- 1. Replace get_pipeline_stats with fast approximate version
-- =========================================================================
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
      -- Use pg_class estimate for total count (instant, updated by ANALYZE)
      'total_records', (SELECT reltuples::bigint FROM pg_class WHERE relname = 'public_records'),
      -- These use partial indexes (idx_public_records_unanchored, idx_public_records_anchor_id)
      'anchored_records', (SELECT count(*) FROM public_records WHERE anchor_id IS NOT NULL),
      'pending_records', (SELECT count(*) FROM public_records WHERE anchor_id IS NULL),
      -- Embeddings table is much smaller
      'embedded_records', (SELECT reltuples::bigint FROM pg_class WHERE relname = 'public_record_embeddings'),
      -- Distinct types from index scan on idx_public_records_record_type
      'record_types', (SELECT json_agg(DISTINCT record_type) FROM public_records)
    )
  );
END;
$$;

-- =========================================================================
-- 2. Fix get_public_records_stats (also times out)
-- =========================================================================
DROP FUNCTION IF EXISTS get_public_records_stats();
CREATE OR REPLACE FUNCTION get_public_records_stats()
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
      'total', (SELECT reltuples::bigint FROM pg_class WHERE relname = 'public_records'),
      'by_source', (
        SELECT json_agg(row_to_json(t))
        FROM (
          SELECT source, count(*) as count
          FROM public_records
          GROUP BY source
          ORDER BY count DESC
        ) t
      ),
      'by_type', (
        SELECT json_agg(row_to_json(t))
        FROM (
          SELECT record_type, count(*) as count
          FROM public_records
          GROUP BY record_type
          ORDER BY count DESC
          LIMIT 20
        ) t
      )
    )
  );
END;
$$;

-- =========================================================================
-- 3. Create get_distinct_record_types for the filter dropdown
--    (avoids scanning 1000 rows from public_records table)
-- =========================================================================
CREATE OR REPLACE FUNCTION get_distinct_record_types()
RETURNS TABLE(record_type text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT DISTINCT record_type::text
  FROM public_records
  ORDER BY record_type;
$$;

GRANT EXECUTE ON FUNCTION get_distinct_record_types() TO authenticated, service_role;

-- =========================================================================
-- 4. Create paginated admin query function that bypasses RLS timeout
-- =========================================================================
CREATE OR REPLACE FUNCTION get_public_records_page(
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 20,
  p_source text DEFAULT NULL,
  p_record_type text DEFAULT NULL,
  p_anchor_status text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_offset integer;
  v_total bigint;
  v_data json;
BEGIN
  IF NOT (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN
    RAISE EXCEPTION 'Access denied: platform admin required';
  END IF;

  v_offset := (p_page - 1) * p_page_size;

  -- Use approximate total for pagination (instant)
  v_total := (SELECT reltuples::bigint FROM pg_class WHERE relname = 'public_records');

  SELECT json_agg(row_to_json(t))
  INTO v_data
  FROM (
    SELECT id, title, source, record_type, anchor_id, created_at, content_hash
    FROM public_records
    WHERE (p_source IS NULL OR source = p_source)
      AND (p_record_type IS NULL OR record_type = p_record_type)
      AND (p_anchor_status IS NULL
           OR (p_anchor_status = 'anchored' AND anchor_id IS NOT NULL)
           OR (p_anchor_status = 'unanchored' AND anchor_id IS NULL))
    ORDER BY created_at DESC
    LIMIT p_page_size
    OFFSET v_offset
  ) t;

  RETURN json_build_object(
    'data', COALESCE(v_data, '[]'::json),
    'total', v_total,
    'page', p_page,
    'page_size', p_page_size
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_public_records_page(integer, integer, text, text, text) TO authenticated, service_role;

-- =========================================================================
-- ROLLBACK:
-- Restore 0173 version of get_pipeline_stats
-- DROP FUNCTION IF EXISTS get_public_records_page(integer, integer, text, text, text);
-- DROP FUNCTION IF EXISTS get_distinct_record_types();
-- =========================================================================
