-- =============================================================================
-- Migration 0036: Add reason parameter to revoke_anchor() function
-- Story: P5-TS-02
-- Date: 2026-03-09
--
-- PURPOSE
-- -------
-- The revoke_anchor() function currently does not accept or persist a
-- revocation reason. The revocation_reason column exists (migration 0022)
-- but the RPC never populates it. This migration adds an optional
-- reason parameter, persists it on the anchor row, and includes it
-- in the audit event details.
--
-- CHANGES
-- -------
-- 1. Recreate revoke_anchor(anchor_id uuid, reason text DEFAULT NULL)
--    to accept and persist revocation_reason + include in audit details.
-- =============================================================================

CREATE OR REPLACE FUNCTION revoke_anchor(anchor_id uuid, reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  anchor_record RECORD;
  caller_profile RECORD;
  truncated_reason text;
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

  -- Truncate reason to column max length (2000 chars, per constraint)
  truncated_reason := left(reason, 2000);

  -- Update anchor status to REVOKED + set reason and revoked_at
  UPDATE anchors
  SET status = 'REVOKED',
      revoked_at = now(),
      revocation_reason = truncated_reason,
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
      'fingerprint', anchor_record.fingerprint,
      'reason', truncated_reason
    )::text
  );
END;
$$;


-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- Restore from 0024_fix_search_path_revoke_anchor.sql:
-- CREATE OR REPLACE FUNCTION revoke_anchor(anchor_id uuid) ...
-- (without reason parameter, without revoked_at/revocation_reason SET)
