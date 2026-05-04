-- Migration 0258: ARK-112 (SCRUM-1121) — anchor queue API uses public_id
--
-- PURPOSE
-- -------
-- The queue resolution API surface (list_pending_resolution_anchors,
-- resolve_anchor_queue) currently returns and accepts the internal
-- anchors.id UUID. CLAUDE.md §6 lists "Exposing user_id / org_id /
-- anchors.id publicly" as a banned pattern — only public_id and derived
-- fields should leave the server. Defense-in-depth over the existing
-- ORG_ADMIN + org-scoped row-lock guards.
--
-- JIRA: SCRUM-1121 (ARK-112)
-- EPIC: SCRUM-1010 (CIBA)
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS resolve_anchor_queue(TEXT, TEXT, TEXT);
--   Re-create the migration 0234 body of resolve_anchor_queue(TEXT, UUID, TEXT)
--   and the migration 0228 body of list_pending_resolution_anchors(INTEGER).
--
-- COMPATIBILITY:
--   Worker + frontend updated in lockstep (this story). The old
--   resolve_anchor_queue(TEXT, UUID, TEXT) is dropped — there are no
--   external API consumers (queue endpoints are admin-only and not
--   published in the verification API contract).

BEGIN;

-- 1. Drop the old internal-UUID-typed resolve RPC. Signature change forces
--    a DROP rather than CREATE OR REPLACE.
DROP FUNCTION IF EXISTS resolve_anchor_queue(TEXT, UUID, TEXT);

-- 2. New resolve RPC takes p_selected_public_id (TEXT). Looks up the
--    internal id once, then proceeds exactly as the migration 0234 body
--    (FOR UPDATE lock + external_file_id cross-check + sibling revoke).
CREATE OR REPLACE FUNCTION resolve_anchor_queue(
  p_external_file_id TEXT,
  p_selected_public_id TEXT,
  p_reason TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  caller_profile RECORD;
  v_selected_anchor anchors%ROWTYPE;
  v_selected_ext_id TEXT;
  v_org_id UUID;
  v_sibling_ids UUID[];
  v_resolution_id UUID;
  v_existing_id UUID;
BEGIN
  SELECT * INTO caller_profile
  FROM profiles
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found'
      USING ERRCODE = 'P0001';
  END IF;

  IF caller_profile.role != 'ORG_ADMIN' THEN
    RAISE EXCEPTION 'Only organization administrators can resolve queued anchors'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Resolve public_id → internal row inside the security-definer body.
  -- The internal id never leaves this function.
  SELECT * INTO v_selected_anchor
  FROM anchors
  WHERE public_id = p_selected_public_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Selected public_id not found'
      USING ERRCODE = 'P0001';
  END IF;

  v_org_id := v_selected_anchor.org_id;

  IF v_org_id IS NULL OR v_org_id != caller_profile.org_id THEN
    RAISE EXCEPTION 'Cannot resolve anchor from different organization'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_selected_anchor.status != 'PENDING_RESOLUTION' THEN
    RAISE EXCEPTION 'Anchor is not awaiting resolution (status: %)', v_selected_anchor.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Cross-check external_file_id (preserved from migration 0234 — guards
  -- against a caller passing a public_id from set A while claiming to
  -- resolve set B and accidentally revoking B's siblings).
  v_selected_ext_id := v_selected_anchor.metadata->>'external_file_id';
  IF v_selected_ext_id IS DISTINCT FROM p_external_file_id THEN
    RAISE EXCEPTION 'Selected anchor external_file_id (%) does not match requested collision set (%)',
      COALESCE(v_selected_ext_id, '<null>'), p_external_file_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Idempotency short-circuit (same resolution requested again).
  SELECT id INTO v_existing_id
  FROM anchor_queue_resolutions
  WHERE org_id = v_org_id
    AND external_file_id = p_external_file_id
    AND selected_anchor_id = v_selected_anchor.id;

  IF v_existing_id IS NOT NULL THEN
    RETURN v_existing_id;
  END IF;

  PERFORM 1
  FROM anchors
  WHERE org_id = v_org_id
    AND status = 'PENDING_RESOLUTION'
    AND metadata->>'external_file_id' = p_external_file_id
    AND deleted_at IS NULL
  FOR UPDATE;

  SELECT ARRAY_AGG(id) INTO v_sibling_ids
  FROM anchors
  WHERE org_id = v_org_id
    AND status = 'PENDING_RESOLUTION'
    AND metadata->>'external_file_id' = p_external_file_id
    AND id != v_selected_anchor.id
    AND deleted_at IS NULL;

  v_sibling_ids := COALESCE(v_sibling_ids, ARRAY[]::UUID[]);

  UPDATE anchors
  SET status = 'PENDING'::anchor_status,
      updated_at = now()
  WHERE id = v_selected_anchor.id;

  IF cardinality(v_sibling_ids) > 0 THEN
    UPDATE anchors
    SET status = 'REVOKED'::anchor_status,
        revoked_at = now(),
        revocation_reason = 'Rejected in queue resolution: superseded by ' || v_selected_anchor.public_id,
        updated_at = now()
    WHERE id = ANY(v_sibling_ids);
  END IF;

  INSERT INTO anchor_queue_resolutions (
    org_id, external_file_id, selected_anchor_id,
    rejected_anchor_ids, reason, resolved_by_user_id
  ) VALUES (
    v_org_id, p_external_file_id, v_selected_anchor.id,
    v_sibling_ids, LEFT(p_reason, 2000), auth.uid()
  )
  RETURNING id INTO v_resolution_id;

  -- audit_events.target_id is TEXT after migration 0143 — use the
  -- human-readable public_id instead of the internal UUID so the
  -- audit log stays joinable to user-facing references.
  INSERT INTO audit_events (
    event_type, event_category, actor_id, actor_email, org_id,
    target_type, target_id, details
  ) VALUES (
    'ANCHOR_QUEUE_RESOLVED', 'ANCHOR',
    auth.uid(), caller_profile.email, v_org_id,
    'anchor', v_selected_anchor.public_id,
    jsonb_build_object(
      'external_file_id', p_external_file_id,
      'selected_public_id', v_selected_anchor.public_id,
      'rejected_anchor_ids', to_jsonb(v_sibling_ids),
      'reason', LEFT(p_reason, 2000),
      'resolution_id', v_resolution_id
    )::text
  );

  RETURN v_resolution_id;
END;
$$;

GRANT EXECUTE ON FUNCTION resolve_anchor_queue(TEXT, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION resolve_anchor_queue(TEXT, TEXT, TEXT) IS
  'ARK-112 (migration 0258): resolve a PENDING_RESOLUTION collision set. Accepts public_id, never the internal anchors.id, to keep internal row identifiers off the wire.';

-- 3. list_pending_resolution_anchors returns public_id instead of id.
--    Same return type (jsonb) so the worker just picks a different key.
CREATE OR REPLACE FUNCTION list_pending_resolution_anchors(p_limit INTEGER DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  caller_profile RECORD;
  v_result jsonb;
BEGIN
  SELECT * INTO caller_profile
  FROM profiles
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found'
      USING ERRCODE = 'P0001';
  END IF;

  IF caller_profile.org_id IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  p_limit := LEAST(GREATEST(p_limit, 1), 500);

  WITH pending AS (
    SELECT
      public_id, metadata, filename, fingerprint, created_at,
      COUNT(*) OVER (PARTITION BY metadata->>'external_file_id') - 1 AS sibling_count
    FROM anchors
    WHERE org_id = caller_profile.org_id
      AND status = 'PENDING_RESOLUTION'
      AND deleted_at IS NULL
  ),
  paged AS (
    SELECT * FROM pending
    ORDER BY created_at DESC
    LIMIT p_limit
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'public_id', public_id,
      'external_file_id', metadata->>'external_file_id',
      'filename', filename,
      'fingerprint', fingerprint,
      'created_at', created_at,
      'sibling_count', sibling_count::INTEGER
    )
    ORDER BY created_at DESC
  ) INTO v_result
  FROM paged;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

COMMENT ON FUNCTION list_pending_resolution_anchors(INTEGER) IS
  'ARK-112 (migration 0258): return PENDING_RESOLUTION anchors for caller org. Emits public_id, never the internal anchors.id.';

NOTIFY pgrst, 'reload schema';

COMMIT;
