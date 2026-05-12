-- Migration 0305: Pipeline admin operational status filters
--
-- SUBMITTED anchors have a network receipt but are not confirmed. The admin
-- records browser must expose lifecycle statuses directly so operators can
-- filter PENDING, BROADCASTING, SUBMITTED/In Mempool, SECURED/Confirmed,
-- EXPIRED, and REVOKED without collapsing SUBMITTED into "anchored".

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
  v_status text := NULLIF(upper(trim(COALESCE(p_anchor_status, ''))), '');
BEGIN
  IF NOT (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN
    RAISE EXCEPTION 'Access denied: platform admin required';
  END IF;

  v_offset := GREATEST(p_page - 1, 0) * p_page_size;

  IF p_source IS NULL AND p_record_type IS NULL AND v_status IS NULL AND v_search IS NULL THEN
    v_total := (SELECT reltuples::bigint FROM pg_class WHERE relname = 'public_records');
  ELSE
    SELECT count(*) INTO v_total
    FROM public_records pr
    LEFT JOIN anchors a ON a.id = pr.anchor_id
    WHERE (p_source IS NULL OR pr.source = p_source)
      AND (p_record_type IS NULL OR pr.record_type = p_record_type)
      AND (
        v_status IS NULL
        OR (v_status = 'UNLINKED' AND pr.anchor_id IS NULL)
        OR (v_status = 'PENDING' AND a.status = 'PENDING')
        OR (v_status = 'BROADCASTING' AND a.status = 'BROADCASTING')
        OR (v_status = 'SUBMITTED' AND a.status = 'SUBMITTED' AND a.chain_tx_id IS NOT NULL)
        OR (v_status = 'SECURED' AND a.status = 'SECURED' AND a.chain_tx_id IS NOT NULL)
        OR (v_status = 'EXPIRED' AND a.status = 'EXPIRED')
        OR (v_status = 'REVOKED' AND a.status = 'REVOKED')
        OR (v_status = 'ANCHORED' AND a.status = 'SECURED' AND a.chain_tx_id IS NOT NULL)
        OR (
          v_status = 'UNANCHORED'
          AND (
            pr.anchor_id IS NULL
            OR a.id IS NULL
            OR a.status <> 'SECURED'
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
        v_status IS NULL
        OR (v_status = 'UNLINKED' AND pr.anchor_id IS NULL)
        OR (v_status = 'PENDING' AND a.status = 'PENDING')
        OR (v_status = 'BROADCASTING' AND a.status = 'BROADCASTING')
        OR (v_status = 'SUBMITTED' AND a.status = 'SUBMITTED' AND a.chain_tx_id IS NOT NULL)
        OR (v_status = 'SECURED' AND a.status = 'SECURED' AND a.chain_tx_id IS NOT NULL)
        OR (v_status = 'EXPIRED' AND a.status = 'EXPIRED')
        OR (v_status = 'REVOKED' AND a.status = 'REVOKED')
        OR (v_status = 'ANCHORED' AND a.status = 'SECURED' AND a.chain_tx_id IS NOT NULL)
        OR (
          v_status = 'UNANCHORED'
          AND (
            pr.anchor_id IS NULL
            OR a.id IS NULL
            OR a.status <> 'SECURED'
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
