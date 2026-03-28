-- Migration: batch_insert_anchors() RPC for 10x conversion throughput
-- Replaces serial one-by-one anchor inserts with single batch call
-- Handles partial unique index (user_id, fingerprint) WHERE deleted_at IS NULL
-- Returns array of {id, fingerprint} for all inserted + existing anchors
-- ROLLBACK: DROP FUNCTION IF EXISTS batch_insert_anchors(jsonb);

CREATE OR REPLACE FUNCTION batch_insert_anchors(
  p_anchors jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
DECLARE
  v_result jsonb;
BEGIN
  WITH input_data AS (
    SELECT
      (elem->>'user_id')::uuid AS user_id,
      (elem->>'org_id')::uuid AS org_id,
      (elem->>'fingerprint')::text AS fingerprint,
      (elem->>'filename')::text AS filename,
      (elem->>'credential_type')::credential_type AS credential_type,
      'PENDING'::anchor_status AS status,
      (elem->'metadata')::jsonb AS metadata
    FROM jsonb_array_elements(p_anchors) AS elem
  ),
  inserted AS (
    INSERT INTO anchors (user_id, org_id, fingerprint, filename, credential_type, status, metadata)
    SELECT user_id, org_id, fingerprint, filename, credential_type, status, metadata
    FROM input_data
    ON CONFLICT (user_id, fingerprint) WHERE deleted_at IS NULL
    DO NOTHING
    RETURNING id, fingerprint
  ),
  existing AS (
    SELECT a.id, a.fingerprint
    FROM anchors a
    INNER JOIN input_data d ON a.user_id = d.user_id AND a.fingerprint = d.fingerprint
    WHERE a.deleted_at IS NULL
    AND a.id NOT IN (SELECT id FROM inserted)
  ),
  all_anchors AS (
    SELECT id, fingerprint FROM inserted
    UNION ALL
    SELECT id, fingerprint FROM existing
  )
  SELECT jsonb_agg(jsonb_build_object('id', id, 'fingerprint', fingerprint))
  INTO v_result
  FROM all_anchors;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;
