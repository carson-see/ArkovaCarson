-- Migration 0246: Scope batch anchor claims by organization for manual queue runs
--
-- SCRUM-1129
-- The worker already claims anchors atomically before broadcasting. Manual org
-- runs need the same safety, but limited to the caller's organization so an
-- admin clicking Run cannot drain the global queue or claim another tenant's
-- anchors.

DROP FUNCTION IF EXISTS claim_pending_anchors(text, integer, boolean);

CREATE OR REPLACE FUNCTION claim_pending_anchors(
  p_worker_id text DEFAULT 'worker-1',
  p_limit integer DEFAULT 50,
  p_exclude_pipeline boolean DEFAULT true,
  p_org_id uuid DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  user_id uuid,
  org_id uuid,
  fingerprint text,
  public_id text,
  metadata jsonb,
  credential_type text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout TO '60s'
AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    UPDATE anchors a
    SET
      status = 'BROADCASTING',
      updated_at = now(),
      metadata = jsonb_set(
        COALESCE(a.metadata, '{}'::jsonb),
        '{_claimed_by}',
        to_jsonb(p_worker_id)
      ) || jsonb_build_object('_claimed_at', to_jsonb(now()::text))
    WHERE a.id IN (
      SELECT a2.id
      FROM anchors a2
      WHERE a2.status = 'PENDING'
        AND a2.deleted_at IS NULL
        AND (p_org_id IS NULL OR a2.org_id = p_org_id)
        AND (
          NOT p_exclude_pipeline
          OR (a2.metadata->>'pipeline_source') IS NULL
        )
      ORDER BY a2.created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 0), 10000)
    )
    RETURNING a.*
  )
  SELECT
    claimed.id, claimed.user_id, claimed.org_id,
    claimed.fingerprint::text, claimed.public_id,
    claimed.metadata, claimed.credential_type::text
  FROM claimed;
END;
$$;

REVOKE EXECUTE ON FUNCTION claim_pending_anchors(text, integer, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_pending_anchors(text, integer, boolean, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
