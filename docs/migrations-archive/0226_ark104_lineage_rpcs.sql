-- Migration 0226: ARK-104 — supersede_anchor + get_anchor_lineage RPCs
--
-- PURPOSE
-- -------
-- Atomic "supersede" flow for credential re-anchoring: revoke the old
-- anchor, insert a new anchor with parent_anchor_id pointing at the old
-- one, and queue the new one for the next Bitcoin batch. The old anchor
-- transitions to SUPERSEDED (added in 0223).
--
-- Persistent-URI property: the ATS/VMS integration link pointing at the
-- ORIGINAL anchor's public_id keeps working. The verify page resolves
-- any member of a lineage to the current head via the existing
-- get_public_anchor pattern (the helper here gives the UI the full
-- chain to render a timeline).
--
-- JIRA: SCRUM-1014 (ARK-104)
-- EPIC: SCRUM-1010 (CIBA)
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS supersede_anchor(uuid, text, text);
--   DROP FUNCTION IF EXISTS get_anchor_lineage(uuid);
--   DROP FUNCTION IF EXISTS get_public_anchor_head(uuid);

-- =============================================================================
-- 1. supersede_anchor(anchor_id, new_fingerprint, reason) → new_anchor_id
-- =============================================================================

CREATE OR REPLACE FUNCTION supersede_anchor(
  old_anchor_id UUID,
  new_fingerprint TEXT,
  reason TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  old_anchor anchors%ROWTYPE;
  caller_profile RECORD;
  new_anchor_id UUID;
  existing_child_id UUID;
  existing_child_id_is_idempotent BOOLEAN;
BEGIN
  -- Fetch caller
  SELECT * INTO caller_profile
  FROM profiles
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found'
      USING ERRCODE = 'P0001';
  END IF;

  -- Only org admins (reuse existing revoke_anchor authorization model)
  IF caller_profile.role != 'ORG_ADMIN' THEN
    RAISE EXCEPTION 'Only organization administrators can supersede anchors'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Fetch old anchor
  SELECT * INTO old_anchor
  FROM anchors
  WHERE id = old_anchor_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Anchor not found'
      USING ERRCODE = 'P0001';
  END IF;

  -- Org match
  IF old_anchor.org_id IS NULL OR old_anchor.org_id != caller_profile.org_id THEN
    RAISE EXCEPTION 'Cannot supersede anchor from a different organization'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Cannot supersede an already-revoked or already-superseded anchor
  IF old_anchor.status IN ('REVOKED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'Anchor is already % — cannot supersede', old_anchor.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Legal hold blocks supersede just as it blocks revoke
  IF old_anchor.legal_hold = true THEN
    RAISE EXCEPTION 'Cannot supersede anchor under legal hold'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Single scan over children: order by fingerprint match first. If the
  -- first row is an idempotent re-call (same fingerprint), return it;
  -- otherwise we've hit a fork attempt and must reject.
  SELECT id, (fingerprint = new_fingerprint)
    INTO existing_child_id, existing_child_id_is_idempotent
  FROM anchors
  WHERE parent_anchor_id = old_anchor_id
    AND deleted_at IS NULL
  ORDER BY (fingerprint = new_fingerprint) DESC
  LIMIT 1;

  IF existing_child_id IS NOT NULL THEN
    IF existing_child_id_is_idempotent THEN
      RETURN existing_child_id;
    END IF;
    RAISE EXCEPTION 'Anchor has already been superseded by %', existing_child_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Insert the new anchor as a child of the old one. version_number is
  -- auto-set by the set_anchor_version_trigger (migration 0031).
  INSERT INTO anchors (
    user_id, org_id, filename, fingerprint,
    status, credential_type, metadata,
    parent_anchor_id,
    description
  ) VALUES (
    old_anchor.user_id, old_anchor.org_id, old_anchor.filename, new_fingerprint,
    'PENDING'::anchor_status,
    old_anchor.credential_type,
    COALESCE(old_anchor.metadata, '{}'::jsonb),
    old_anchor_id,
    old_anchor.description
  )
  RETURNING id INTO new_anchor_id;

  -- Flip the old anchor to SUPERSEDED. This is a distinct terminal state
  -- (not REVOKED) so the verify page can render "a newer version exists"
  -- instead of "this was invalidated."
  UPDATE anchors
  SET status = 'SUPERSEDED',
      revoked_at = now(),
      revocation_reason = COALESCE(LEFT(reason, 2000), 'Superseded by newer version'),
      updated_at = now()
  WHERE id = old_anchor_id;

  -- Audit: two events tell the full story — the old went down, the new went up.
  INSERT INTO audit_events (
    event_type, event_category, actor_id, actor_email, org_id,
    target_type, target_id, details
  ) VALUES (
    'ANCHOR_SUPERSEDED', 'ANCHOR',
    auth.uid(), caller_profile.email, caller_profile.org_id,
    'anchor', old_anchor_id::text,
    jsonb_build_object(
      'previous_status', old_anchor.status,
      'new_anchor_id', new_anchor_id,
      'new_fingerprint', new_fingerprint,
      'reason', LEFT(reason, 2000)
    )::text
  );

  INSERT INTO audit_events (
    event_type, event_category, actor_id, actor_email, org_id,
    target_type, target_id, details
  ) VALUES (
    'ANCHOR_CREATED', 'ANCHOR',
    auth.uid(), caller_profile.email, caller_profile.org_id,
    'anchor', new_anchor_id::text,
    jsonb_build_object(
      'parent_anchor_id', old_anchor_id,
      'supersedes_previous', true
    )::text
  );

  RETURN new_anchor_id;
END;
$$;

GRANT EXECUTE ON FUNCTION supersede_anchor(UUID, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION supersede_anchor IS
  'ARK-104: atomically supersede an anchor with a new fingerprint. Old anchor → SUPERSEDED; new anchor → PENDING with parent_anchor_id set. Idempotent on (parent, new_fingerprint).';


-- =============================================================================
-- 2. get_anchor_lineage(anchor_id) → jsonb[]
-- =============================================================================

CREATE OR REPLACE FUNCTION get_anchor_lineage(p_anchor_id UUID)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_root_id UUID;
  v_result jsonb;
  v_caller_org UUID;
  v_anchor_org UUID;
BEGIN
  -- Fetch the anchor's org for RLS equivalence. get_public_anchor allows
  -- unauth reads through this path; we match that behavior but still
  -- check deleted_at.
  SELECT org_id INTO v_anchor_org
  FROM anchors
  WHERE id = p_anchor_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Anchor not found'
      USING ERRCODE = 'P0001';
  END IF;

  -- Walk to the root by following parent_anchor_id. Capped at 100 hops
  -- to prevent runaway cycles if constraints were ever bypassed.
  WITH RECURSIVE ancestry AS (
    SELECT id, parent_anchor_id, 1 AS hop
    FROM anchors
    WHERE id = p_anchor_id
    UNION ALL
    SELECT a.id, a.parent_anchor_id, ancestry.hop + 1
    FROM anchors a
    INNER JOIN ancestry ON a.id = ancestry.parent_anchor_id
    WHERE ancestry.hop < 100
      AND a.deleted_at IS NULL
  )
  SELECT id INTO v_root_id
  FROM ancestry
  WHERE parent_anchor_id IS NULL
  LIMIT 1;

  -- If we couldn't walk to a root, use the passed id as the root.
  IF v_root_id IS NULL THEN
    v_root_id := p_anchor_id;
  END IF;

  -- Fetch the whole descendant chain from the root, ordered by version.
  -- Hop cap mirrors the ancestry walk — defense-in-depth against any cycle
  -- that somehow slipped past `anchors_no_self_reference` (e.g. a 2-cycle
  -- written by a rogue service_role path).
  WITH RECURSIVE descendants AS (
    SELECT a.*, 1 AS hop FROM anchors a
    WHERE a.id = v_root_id AND a.deleted_at IS NULL
    UNION ALL
    SELECT a.*, d.hop + 1 FROM anchors a
    INNER JOIN descendants d ON a.parent_anchor_id = d.id
    WHERE a.deleted_at IS NULL AND d.hop < 100
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', id,
      'public_id', public_id,
      'version_number', version_number,
      'parent_anchor_id', parent_anchor_id,
      'status', status::text,
      'fingerprint', fingerprint,
      'chain_tx_id', chain_tx_id,
      'chain_block_height', chain_block_height,
      'chain_timestamp', chain_timestamp,
      'created_at', created_at,
      'revoked_at', revoked_at,
      'revocation_reason', revocation_reason,
      'is_current', (status NOT IN ('REVOKED', 'SUPERSEDED'))
    )
    ORDER BY version_number ASC
  ) INTO v_result
  FROM descendants;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION get_anchor_lineage(UUID) TO authenticated, anon;

COMMENT ON FUNCTION get_anchor_lineage IS
  'ARK-104: return the full lineage chain for an anchor (any version). Root-first, ordered by version_number. is_current flag marks the head for UI rendering.';


-- =============================================================================
-- 3. Persistent-URI helper — given any lineage-member public_id, return
--    the CURRENT head's public_id. Used by the verify page.
-- =============================================================================

CREATE OR REPLACE FUNCTION get_current_anchor_public_id(p_public_id TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_anchor_id UUID;
  v_current_id UUID;
  v_current_public_id TEXT;
BEGIN
  SELECT id INTO v_anchor_id
  FROM anchors
  WHERE public_id = p_public_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Walk descendants to the current head. Cap at 100 hops.
  WITH RECURSIVE walk AS (
    SELECT id, 1 AS hop
    FROM anchors
    WHERE id = v_anchor_id
    UNION ALL
    SELECT a.id, walk.hop + 1
    FROM anchors a
    INNER JOIN walk ON a.parent_anchor_id = walk.id
    WHERE walk.hop < 100 AND a.deleted_at IS NULL
  )
  -- Deterministic tie-break: if the tree ever forks (rejected on insert, but
  -- historical data may have them), always pick the same leaf across reads.
  SELECT walk.id INTO v_current_id
  FROM walk
  INNER JOIN anchors a ON a.id = walk.id
  ORDER BY walk.hop DESC, a.created_at DESC, a.id ASC
  LIMIT 1;

  SELECT public_id INTO v_current_public_id
  FROM anchors
  WHERE id = v_current_id;

  RETURN v_current_public_id;
END;
$$;

GRANT EXECUTE ON FUNCTION get_current_anchor_public_id(TEXT) TO authenticated, anon;

COMMENT ON FUNCTION get_current_anchor_public_id IS
  'ARK-104: given any public_id in a lineage, return the CURRENT head public_id. The verify page uses this so a stale ATS/VMS link still resolves to the up-to-date credential.';


-- =============================================================================
-- 4. Schema cache reload
-- =============================================================================

NOTIFY pgrst, 'reload schema';
