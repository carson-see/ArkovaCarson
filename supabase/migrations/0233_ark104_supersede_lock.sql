-- Migration 0233: ARK-104 follow-up — lock the parent row during supersede_anchor.
--
-- Context (CodeRabbit review of PR #474, 2026-04-23):
--   The original supersede_anchor (migration 0226) reads the parent anchor
--   without a lock, so two concurrent callers can both pass the status
--   + legal-hold checks and each insert a child anchor, forking the
--   lineage. The child-scan pattern (ORDER BY fingerprint match DESC) is
--   clever but still racy because it reads uncommitted state from the
--   parallel txn.
--
-- Fix:
--   1. CREATE OR REPLACE FUNCTION with identical signature + body EXCEPT
--      the SELECT INTO old_anchor now locks the parent FOR UPDATE.
--      Postgres READ COMMITTED + FOR UPDATE means the second caller waits
--      until the first commits, then re-reads the row and observes
--      status = 'SUPERSEDED' → raises the existing "already superseded"
--      exception path.
--   2. Add a unique partial index as a DB-level safeguard against any
--      surviving race (e.g. admin runs two psql sessions directly). Index:
--      anchors(parent_anchor_id) WHERE parent_anchor_id IS NOT NULL AND
--      deleted_at IS NULL AND status NOT IN ('REVOKED'). The status filter
--      allows re-supersede after an admin revokes the failed child (rare
--      but valid repair flow).
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS anchors_unique_active_child_per_parent;
--   Restore migration 0226 section 1 CREATE OR REPLACE FUNCTION
--   supersede_anchor(uuid, text, text) body without FOR UPDATE.

BEGIN;

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

  -- Only org admins
  IF caller_profile.role != 'ORG_ADMIN' THEN
    RAISE EXCEPTION 'Only organization administrators can supersede anchors'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Fetch + LOCK the old anchor. Without FOR UPDATE two concurrent callers
  -- could both pass the status + legal-hold checks and each insert a child
  -- anchor, forking the lineage. FOR UPDATE serializes them: the second
  -- caller blocks until the first commits, then re-reads the row and sees
  -- status = 'SUPERSEDED' → raises the "already superseded" exception
  -- below. The unique partial index added at the end of this migration is
  -- belt-and-suspenders for any surviving race.
  SELECT * INTO old_anchor
  FROM anchors
  WHERE id = old_anchor_id
    AND deleted_at IS NULL
  FOR UPDATE;

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

  -- Insert the new anchor as a child of the old one.
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

  -- Flip the old anchor to SUPERSEDED.
  UPDATE anchors
  SET status = 'SUPERSEDED',
      revoked_at = now(),
      revocation_reason = COALESCE(LEFT(reason, 2000), 'Superseded by newer version'),
      updated_at = now()
  WHERE id = old_anchor_id;

  -- Audit (unchanged from 0226)
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

-- DB-level safeguard: at most one active (non-deleted, non-revoked) child per
-- parent. Matches the semantic "a lineage is a chain, not a tree." If the
-- FOR UPDATE lock above fails for any reason, the second INSERT hits this
-- index and errors out with a unique violation rather than forking silently.
--
-- The index is partial + conditional so re-supersede flows after an admin
-- revokes a failed child still work.
CREATE UNIQUE INDEX IF NOT EXISTS anchors_unique_active_child_per_parent
  ON anchors (parent_anchor_id)
  WHERE parent_anchor_id IS NOT NULL
    AND deleted_at IS NULL
    AND status NOT IN ('REVOKED');

COMMENT ON INDEX anchors_unique_active_child_per_parent IS
  'ARK-104 hardening (migration 0233): at most one non-revoked, non-deleted child per parent anchor. Enforces lineage is a chain, not a tree, even if application-level locks fail.';

COMMIT;
