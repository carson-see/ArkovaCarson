-- Migration 0228: ARK-101 — anchor_queue_resolutions + queue helpers
--
-- PURPOSE
-- -------
-- When multiple rapid anchor webhooks for the same external_file_id
-- arrive within a configurable window, the rules engine (ARK-106) flags
-- all of them as PENDING_RESOLUTION. An org admin (or an authorised MCP
-- agent) then resolves the collision by picking the terminal version;
-- that pick is recorded here for audit.
--
-- JIRA: SCRUM-1011 (ARK-101 / INT-11)
-- EPIC: SCRUM-1010 (CIBA)
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS anchor_queue_resolutions;

-- =============================================================================
-- 1. anchor_queue_resolutions table
-- =============================================================================

CREATE TABLE anchor_queue_resolutions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Upstream external file id (e.g. Google Drive fileId, DocuSign
  -- envelopeId, Veremark referenceId). This groups the collision set.
  external_file_id        TEXT NOT NULL,

  -- The anchor the admin / agent picked as the terminal version.
  selected_anchor_id      UUID NOT NULL REFERENCES anchors(id) ON DELETE CASCADE,

  -- Rejected siblings — the versions the admin declined. Stored as a
  -- uuid[] so queries can fan out to flip each to REVOKED in a single
  -- transaction.
  rejected_anchor_ids     UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],

  -- Free-text reason (optional). Capped hard — admin authored.
  reason                  TEXT,

  -- Who resolved. Always authenticated; NULL only in the rare service-
  -- role auto-resolve path (e.g. dedupe cron for orphaned items).
  resolved_by_user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Or — an MCP agent API key id, when programmatic. Mutually
  -- exclusive with resolved_by_user_id for human callers.
  resolved_by_api_key_id  UUID,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT anchor_queue_resolutions_external_file_id_length
    CHECK (char_length(external_file_id) BETWEEN 1 AND 255),
  CONSTRAINT anchor_queue_resolutions_reason_length
    CHECK (reason IS NULL OR char_length(reason) <= 2000),
  CONSTRAINT anchor_queue_resolutions_rejected_count
    CHECK (cardinality(rejected_anchor_ids) <= 100),
  CONSTRAINT anchor_queue_resolutions_actor_exclusive
    CHECK (
      (resolved_by_user_id IS NOT NULL AND resolved_by_api_key_id IS NULL) OR
      (resolved_by_user_id IS NULL     AND resolved_by_api_key_id IS NOT NULL) OR
      (resolved_by_user_id IS NULL     AND resolved_by_api_key_id IS NULL) -- service role
    )
);

-- Idempotency: a given (org, external_file_id, selected_anchor_id)
-- combination can only be recorded once.
CREATE UNIQUE INDEX idx_anchor_queue_resolutions_idempotency
  ON anchor_queue_resolutions(org_id, external_file_id, selected_anchor_id);

CREATE INDEX idx_anchor_queue_resolutions_org_created
  ON anchor_queue_resolutions(org_id, created_at DESC);

COMMENT ON TABLE anchor_queue_resolutions IS
  'ARK-101: admin or agent resolution of multi-version anchor collisions. Links the selected anchor + rejected siblings + reason.';

ALTER TABLE anchor_queue_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE anchor_queue_resolutions FORCE ROW LEVEL SECURITY;

GRANT SELECT ON anchor_queue_resolutions TO authenticated;

-- Org members can read their org's resolutions for audit.
CREATE POLICY anchor_queue_resolutions_select ON anchor_queue_resolutions
  FOR SELECT TO authenticated
  USING (
    org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );

-- Inserts are service-role only (worker-originated via resolve_anchor_queue
-- RPC). Direct client inserts bypass the sibling-revocation logic.

-- =============================================================================
-- 2. resolve_anchor_queue(org_id, external_file_id, selected_anchor_id, reason)
-- =============================================================================

CREATE OR REPLACE FUNCTION resolve_anchor_queue(
  p_external_file_id TEXT,
  p_selected_anchor_id UUID,
  p_reason TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  caller_profile RECORD;
  v_org_id UUID;
  v_selected_anchor anchors%ROWTYPE;
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

  -- Selected anchor must exist + belong to caller's org + be in PENDING_RESOLUTION.
  SELECT * INTO v_selected_anchor
  FROM anchors
  WHERE id = p_selected_anchor_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Selected anchor not found'
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

  -- Idempotency short-circuit — same resolution requested again.
  SELECT id INTO v_existing_id
  FROM anchor_queue_resolutions
  WHERE org_id = v_org_id
    AND external_file_id = p_external_file_id
    AND selected_anchor_id = p_selected_anchor_id;

  IF v_existing_id IS NOT NULL THEN
    RETURN v_existing_id;
  END IF;

  -- Row-lock the entire PENDING_RESOLUTION collision set so two admins
  -- can't concurrently pick different terminal versions and each revoke
  -- the other's pick. FOR UPDATE blocks the other caller until this
  -- transaction commits; they then observe selected_anchor in PENDING
  -- state and fall through the status guard above.
  PERFORM 1
  FROM anchors
  WHERE org_id = v_org_id
    AND status = 'PENDING_RESOLUTION'
    AND metadata->>'external_file_id' = p_external_file_id
    AND deleted_at IS NULL
  FOR UPDATE;

  -- Collect sibling anchor ids (same external_file_id, org, PENDING_RESOLUTION,
  -- excluding the selected one). Worker tags anchors with metadata->>'external_file_id'
  -- at creation time; we filter by that.
  SELECT ARRAY_AGG(id) INTO v_sibling_ids
  FROM anchors
  WHERE org_id = v_org_id
    AND status = 'PENDING_RESOLUTION'
    AND metadata->>'external_file_id' = p_external_file_id
    AND id != p_selected_anchor_id
    AND deleted_at IS NULL;

  v_sibling_ids := COALESCE(v_sibling_ids, ARRAY[]::UUID[]);

  -- Flip selected → PENDING so the batch worker can process it.
  UPDATE anchors
  SET status = 'PENDING'::anchor_status,
      updated_at = now()
  WHERE id = p_selected_anchor_id;

  -- Revoke rejected siblings.
  IF cardinality(v_sibling_ids) > 0 THEN
    UPDATE anchors
    SET status = 'REVOKED'::anchor_status,
        revoked_at = now(),
        revocation_reason = 'Rejected in queue resolution: superseded by ' || p_selected_anchor_id::text,
        updated_at = now()
    WHERE id = ANY(v_sibling_ids);
  END IF;

  -- Record the resolution.
  INSERT INTO anchor_queue_resolutions (
    org_id, external_file_id, selected_anchor_id,
    rejected_anchor_ids, reason, resolved_by_user_id
  ) VALUES (
    v_org_id, p_external_file_id, p_selected_anchor_id,
    v_sibling_ids, LEFT(p_reason, 2000), auth.uid()
  )
  RETURNING id INTO v_resolution_id;

  -- Audit
  INSERT INTO audit_events (
    event_type, event_category, actor_id, actor_email, org_id,
    target_type, target_id, details
  ) VALUES (
    'ANCHOR_QUEUE_RESOLVED', 'ANCHOR',
    auth.uid(), caller_profile.email, v_org_id,
    'anchor', p_selected_anchor_id::text,
    jsonb_build_object(
      'external_file_id', p_external_file_id,
      'selected_anchor_id', p_selected_anchor_id,
      'rejected_anchor_ids', v_sibling_ids,
      'reason', LEFT(p_reason, 2000)
    )::text
  );

  RETURN v_resolution_id;
END;
$$;

GRANT EXECUTE ON FUNCTION resolve_anchor_queue(TEXT, UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION resolve_anchor_queue IS
  'ARK-101: admin picks the terminal version among PENDING_RESOLUTION anchors sharing an external_file_id. Selected → PENDING; siblings → REVOKED; resolution row persisted.';


-- =============================================================================
-- 3. list_pending_resolution_anchors(org_id) → jsonb
-- =============================================================================

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

  -- Clamp limit defensively so pathological callers can't DOS the table.
  p_limit := LEAST(GREATEST(p_limit, 1), 500);

  -- Window function computes sibling_count over the PENDING_RESOLUTION set
  -- in a single scan — replaces the per-row correlated subquery that would
  -- N+1 at scale.
  WITH pending AS (
    SELECT
      id, metadata, filename, fingerprint, created_at,
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
      'id', id,
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

GRANT EXECUTE ON FUNCTION list_pending_resolution_anchors(INTEGER) TO authenticated;

COMMENT ON FUNCTION list_pending_resolution_anchors IS
  'ARK-101: return anchors in PENDING_RESOLUTION state for the caller''s org, with sibling counts for collision visualization.';


-- =============================================================================
-- 4. Schema cache reload
-- =============================================================================

NOTIFY pgrst, 'reload schema';
