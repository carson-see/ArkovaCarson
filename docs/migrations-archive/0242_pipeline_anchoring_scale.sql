-- Migration 0242: Pipeline anchoring scale + honest dashboard metrics
--
-- Fixes the 2k/10k contradiction by adding bulk finalization helpers for
-- public-record anchoring and updates dashboard stats so "anchored" means
-- "has a Bitcoin tx", not merely "has an internal anchor row".
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS finalize_public_record_anchor_batch(jsonb, text, bigint, timestamptz, text, text);
--   DROP FUNCTION IF EXISTS link_public_records_to_anchors(jsonb);
--   DROP INDEX IF EXISTS idx_anchors_pipeline_status;
--   DROP INDEX IF EXISTS idx_public_records_source_id_trgm;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- NOTE: idx_anchors_pipeline_status and idx_public_records_source_id_trgm
-- moved to migration 0255_deferred_slow_indexes.sql — they cannot be built
-- via Supabase's CLI/pooler (hard statement timeout; 1.4M-row anchors +
-- gin_trgm on public_records). Apply manually via Supabase Dashboard SQL
-- Editor. Runbook: docs/runbooks/supabase/long-running-migrations.md

CREATE OR REPLACE FUNCTION finalize_public_record_anchor_batch(
  p_items jsonb,
  p_tx_id text,
  p_block_height bigint DEFAULT NULL,
  p_block_timestamp timestamptz DEFAULT NULL,
  p_merkle_root text DEFAULT NULL,
  p_batch_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
DECLARE
  v_anchors_updated bigint := 0;
  v_records_updated bigint := 0;
BEGIN
  WITH input_data AS (
    SELECT
      (elem->>'record_id')::uuid AS record_id,
      (elem->>'anchor_id')::uuid AS anchor_id,
      COALESCE(elem->'merkle_proof', '[]'::jsonb) AS merkle_proof
    FROM jsonb_array_elements(p_items) AS elem
  ),
  anchor_input AS (
    SELECT DISTINCT ON (anchor_id) anchor_id, merkle_proof
    FROM input_data
    ORDER BY anchor_id
  ),
  updated_anchors AS (
    UPDATE anchors a
    SET
      status = 'SUBMITTED',
      chain_tx_id = p_tx_id,
      chain_block_height = p_block_height,
      chain_timestamp = p_block_timestamp,
      updated_at = now(),
      metadata = COALESCE(a.metadata, '{}'::jsonb)
        - '_claimed_by' - '_claimed_at'
        || jsonb_build_object(
          'merkle_proof', ai.merkle_proof,
          'merkle_root', p_merkle_root,
          'batch_id', p_batch_id
        )
    FROM anchor_input ai
    WHERE a.id = ai.anchor_id
      AND a.deleted_at IS NULL
      AND a.status = 'BROADCASTING'
    RETURNING a.id
  ),
  eligible_items AS (
    SELECT i.*
    FROM input_data i
    JOIN updated_anchors ua ON ua.id = i.anchor_id
  ),
  updated_records AS (
    UPDATE public_records pr
    SET
      anchor_id = ei.anchor_id,
      updated_at = now(),
      metadata = COALESCE(pr.metadata, '{}'::jsonb)
        || jsonb_build_object(
          'merkle_proof', ei.merkle_proof,
          'merkle_root', p_merkle_root,
          'batch_id', p_batch_id,
          'chain_tx_id', p_tx_id
        )
    FROM eligible_items ei
    WHERE pr.id = ei.record_id
      AND (pr.anchor_id IS NULL OR pr.anchor_id = ei.anchor_id)
    RETURNING pr.id
  )
  SELECT
    (SELECT count(*) FROM updated_anchors),
    (SELECT count(*) FROM updated_records)
  INTO v_anchors_updated, v_records_updated;

  RETURN jsonb_build_object(
    'anchors_updated', COALESCE(v_anchors_updated, 0),
    'records_updated', COALESCE(v_records_updated, 0)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION finalize_public_record_anchor_batch(jsonb, text, bigint, timestamptz, text, text) TO service_role;

CREATE OR REPLACE FUNCTION link_public_records_to_anchors(
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '60s'
AS $$
DECLARE
  v_records_updated bigint := 0;
BEGIN
  WITH input_data AS (
    SELECT
      (elem->>'record_id')::uuid AS record_id,
      (elem->>'anchor_id')::uuid AS anchor_id
    FROM jsonb_array_elements(p_items) AS elem
  ),
  updated_records AS (
    UPDATE public_records pr
    SET
      anchor_id = i.anchor_id,
      updated_at = now(),
      metadata = COALESCE(pr.metadata, '{}'::jsonb)
        || jsonb_strip_nulls(jsonb_build_object(
          'merkle_proof', COALESCE(a.metadata->'merkle_proof', '[]'::jsonb),
          'merkle_root', a.metadata->>'merkle_root',
          'batch_id', a.metadata->>'batch_id',
          'chain_tx_id', a.chain_tx_id
        ))
    FROM input_data i
    JOIN anchors a ON a.id = i.anchor_id
    WHERE pr.id = i.record_id
      AND (pr.anchor_id IS NULL OR pr.anchor_id = i.anchor_id)
      AND a.deleted_at IS NULL
      AND a.status IN ('SUBMITTED', 'SECURED')
      AND a.chain_tx_id IS NOT NULL
    RETURNING pr.id
  )
  SELECT count(*) INTO v_records_updated FROM updated_records;

  RETURN jsonb_build_object('records_updated', COALESCE(v_records_updated, 0));
END;
$$;

GRANT EXECUTE ON FUNCTION link_public_records_to_anchors(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION refresh_cache_pipeline_stats()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '60s'
AS $FN$
DECLARE
  v_total bigint;
  v_embedded bigint;
  v_linked bigint;
  v_unlinked bigint;
  v_pending_anchor bigint;
  v_broadcasting bigint;
  v_submitted bigint;
  v_secured bigint;
  v_bitcoin_anchored bigint;
  v_pending_bitcoin bigint;
BEGIN
  SELECT reltuples::bigint INTO v_total FROM pg_class WHERE relname = 'public_records';

  SELECT count(*) INTO v_unlinked
  FROM public_records
  WHERE anchor_id IS NULL;

  v_linked := GREATEST(COALESCE(v_total, 0) - COALESCE(v_unlinked, 0), 0);

  SELECT count(*) INTO v_embedded
  FROM public_record_embeddings;

  SELECT
    count(*) FILTER (WHERE status = 'PENDING'),
    count(*) FILTER (WHERE status = 'BROADCASTING'),
    count(*) FILTER (WHERE status = 'SUBMITTED' AND chain_tx_id IS NOT NULL),
    count(*) FILTER (WHERE status = 'SECURED' AND chain_tx_id IS NOT NULL)
  INTO v_pending_anchor, v_broadcasting, v_submitted, v_secured
  FROM anchors
  WHERE deleted_at IS NULL
    AND metadata ? 'pipeline_source';

  v_bitcoin_anchored := COALESCE(v_submitted, 0) + COALESCE(v_secured, 0);
  v_pending_bitcoin := COALESCE(v_unlinked, 0) + COALESCE(v_pending_anchor, 0) + COALESCE(v_broadcasting, 0);

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('pipeline_stats', jsonb_build_object(
    'total_records', COALESCE(v_total, 0),
    'anchor_linked_records', COALESCE(v_linked, 0),
    'pending_record_links', COALESCE(v_unlinked, 0),
    'bitcoin_anchored_records', COALESCE(v_bitcoin_anchored, 0),
    'pending_bitcoin_records', COALESCE(v_pending_bitcoin, 0),
    'pending_anchor_records', COALESCE(v_pending_anchor, 0),
    'broadcasting_records', COALESCE(v_broadcasting, 0),
    'submitted_records', COALESCE(v_submitted, 0),
    'secured_records', COALESCE(v_secured, 0),
    'embedded_records', COALESCE(v_embedded, 0)
  ), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$FN$;

CREATE OR REPLACE FUNCTION get_pipeline_stats()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $FN$
DECLARE
  v_cached jsonb;
  v_updated_at timestamptz;
  v_total bigint;
  v_embedded bigint;
BEGIN
  IF NOT (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN RAISE EXCEPTION 'Access denied: platform admin required'; END IF;

  SELECT cache_value, updated_at INTO v_cached, v_updated_at
  FROM pipeline_dashboard_cache
  WHERE cache_key = 'pipeline_stats';

  IF v_cached IS NOT NULL THEN
    RETURN (v_cached || jsonb_build_object('cache_updated_at', v_updated_at))::json;
  END IF;

  SELECT reltuples::bigint INTO v_total FROM pg_class WHERE relname = 'public_records';
  SELECT reltuples::bigint INTO v_embedded FROM pg_class WHERE relname = 'public_record_embeddings';
  RETURN json_build_object(
    'total_records', COALESCE(v_total, 0),
    'anchor_linked_records', 0,
    'pending_record_links', COALESCE(v_total, 0),
    'bitcoin_anchored_records', 0,
    'pending_bitcoin_records', COALESCE(v_total, 0),
    'pending_anchor_records', 0,
    'broadcasting_records', 0,
    'submitted_records', 0,
    'secured_records', 0,
    'embedded_records', COALESCE(v_embedded, 0),
    'cache_miss', true
  );
END;
$FN$;

GRANT EXECUTE ON FUNCTION refresh_cache_pipeline_stats() TO service_role;
GRANT EXECUTE ON FUNCTION get_pipeline_stats() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION get_public_records_page(
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 20,
  p_source text DEFAULT NULL,
  p_record_type text DEFAULT NULL,
  p_anchor_status text DEFAULT NULL,
  p_search text DEFAULT NULL
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
  v_search text := NULLIF(trim(COALESCE(p_search, '')), '');
BEGIN
  IF NOT (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN
    RAISE EXCEPTION 'Access denied: platform admin required';
  END IF;

  v_offset := GREATEST(p_page - 1, 0) * p_page_size;

  IF p_source IS NULL AND p_record_type IS NULL AND p_anchor_status IS NULL AND v_search IS NULL THEN
    v_total := (SELECT reltuples::bigint FROM pg_class WHERE relname = 'public_records');
  ELSE
    SELECT count(*) INTO v_total
    FROM public_records pr
    LEFT JOIN anchors a ON a.id = pr.anchor_id
    WHERE (p_source IS NULL OR pr.source = p_source)
      AND (p_record_type IS NULL OR pr.record_type = p_record_type)
      AND (
        p_anchor_status IS NULL
        OR (
          p_anchor_status = 'anchored'
          AND a.status IN ('SUBMITTED', 'SECURED')
          AND a.chain_tx_id IS NOT NULL
        )
        OR (
          p_anchor_status = 'unanchored'
          AND (
            pr.anchor_id IS NULL
            OR a.id IS NULL
            OR a.status NOT IN ('SUBMITTED', 'SECURED')
            OR a.chain_tx_id IS NULL
          )
        )
      )
      AND (
        v_search IS NULL
        OR pr.title ILIKE '%' || v_search || '%'
        OR pr.source_id ILIKE '%' || v_search || '%'
        OR pr.content_hash ILIKE v_search || '%'
      );
  END IF;

  SELECT json_agg(row_to_json(t))
  INTO v_data
  FROM (
    SELECT
      pr.id,
      pr.title,
      pr.source,
      pr.source_id,
      pr.source_url,
      pr.record_type,
      pr.anchor_id,
      pr.metadata,
      pr.created_at,
      pr.updated_at,
      pr.content_hash,
      a.status::text AS anchor_status,
      a.chain_tx_id
    FROM public_records pr
    LEFT JOIN anchors a ON a.id = pr.anchor_id
    WHERE (p_source IS NULL OR pr.source = p_source)
      AND (p_record_type IS NULL OR pr.record_type = p_record_type)
      AND (
        p_anchor_status IS NULL
        OR (
          p_anchor_status = 'anchored'
          AND a.status IN ('SUBMITTED', 'SECURED')
          AND a.chain_tx_id IS NOT NULL
        )
        OR (
          p_anchor_status = 'unanchored'
          AND (
            pr.anchor_id IS NULL
            OR a.id IS NULL
            OR a.status NOT IN ('SUBMITTED', 'SECURED')
            OR a.chain_tx_id IS NULL
          )
        )
      )
      AND (
        v_search IS NULL
        OR pr.title ILIKE '%' || v_search || '%'
        OR pr.source_id ILIKE '%' || v_search || '%'
        OR pr.content_hash ILIKE v_search || '%'
      )
    ORDER BY pr.created_at DESC
    LIMIT p_page_size
    OFFSET v_offset
  ) t;

  RETURN json_build_object(
    'data', COALESCE(v_data, '[]'::json),
    'total', COALESCE(v_total, 0),
    'page', p_page,
    'page_size', p_page_size
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_public_records_page(integer, integer, text, text, text, text) TO authenticated, service_role;
