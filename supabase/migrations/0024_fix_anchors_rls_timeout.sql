-- Migration: 0024_fix_anchors_rls_timeout.sql
-- Description: Fix PG 57014 statement timeout on org registry anchors query.
--   The anchors_select_org RLS policy calls get_user_org_id() and is_org_admin()
--   which each perform a profiles lookup per-row, causing timeouts.
--   Fix: replace the two-function policy with a single subquery, and add a
--   composite index covering the common org registry query pattern.
-- Rollback:
--   DROP POLICY IF EXISTS anchors_select_org ON anchors;
--   CREATE POLICY anchors_select_org ON anchors FOR SELECT TO authenticated
--     USING (org_id = get_user_org_id() AND is_org_admin());
--   DROP INDEX IF EXISTS idx_anchors_org_deleted_created;

-- =============================================================================
-- 1. Add composite index for org registry query pattern:
--    WHERE org_id = ? AND deleted_at IS NULL ORDER BY created_at DESC
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_anchors_org_deleted_created
  ON anchors(org_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- =============================================================================
-- 2. Replace anchors_select_org policy with optimized single-subquery version
--    Instead of calling two functions (2 profile lookups), use one EXISTS subquery.
-- =============================================================================
DROP POLICY IF EXISTS anchors_select_org ON anchors;

CREATE POLICY anchors_select_org ON anchors
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND p.role = 'ORG_ADMIN'
        AND p.org_id = anchors.org_id
    )
  );

-- =============================================================================
-- 3. Ensure profiles has an index on (id, role, org_id) for the above subquery
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_profiles_id_role_org
  ON profiles(id, role, org_id);

-- =============================================================================
-- MERGED FROM: 0024_fix_search_path_revoke_anchor.sql
-- =============================================================================
-- Migration: 0024_fix_search_path_revoke_anchor.sql
-- Description: Fix CV-03 — Add SET search_path to revoke_anchor() SECURITY DEFINER function
-- Rollback: Re-run 0012_revoke_anchor_function.sql (restores function without SET search_path)

-- Recreate revoke_anchor() with SET search_path = public, pg_temp
CREATE OR REPLACE FUNCTION revoke_anchor(anchor_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  anchor_record RECORD;
  caller_profile RECORD;
BEGIN
  -- Get the caller's profile
  SELECT * INTO caller_profile
  FROM profiles
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found'
      USING ERRCODE = 'P0001';
  END IF;

  -- Verify caller is ORG_ADMIN
  IF caller_profile.role != 'ORG_ADMIN' THEN
    RAISE EXCEPTION 'Only organization administrators can revoke anchors'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Get the anchor
  SELECT * INTO anchor_record
  FROM anchors
  WHERE id = anchor_id
  AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Anchor not found'
      USING ERRCODE = 'P0001';
  END IF;

  -- Verify anchor belongs to caller's org
  IF anchor_record.org_id IS NULL OR anchor_record.org_id != caller_profile.org_id THEN
    RAISE EXCEPTION 'Cannot revoke anchor from different organization'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Verify anchor is not already revoked
  IF anchor_record.status = 'REVOKED' THEN
    RAISE EXCEPTION 'Anchor is already revoked'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Verify anchor is not under legal hold
  IF anchor_record.legal_hold = true THEN
    RAISE EXCEPTION 'Cannot revoke anchor under legal hold'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Update anchor status to REVOKED
  UPDATE anchors
  SET status = 'REVOKED',
      updated_at = now()
  WHERE id = anchor_id;

  -- Emit audit event
  INSERT INTO audit_events (
    event_type,
    event_category,
    actor_id,
    actor_email,
    org_id,
    target_type,
    target_id,
    details
  ) VALUES (
    'ANCHOR_REVOKED',
    'ANCHOR',
    auth.uid(),
    caller_profile.email,
    caller_profile.org_id,
    'anchor',
    anchor_id::text,
    jsonb_build_object(
      'previous_status', anchor_record.status,
      'filename', anchor_record.filename,
      'fingerprint', anchor_record.fingerprint
    )::text
  );
END;
$$;
