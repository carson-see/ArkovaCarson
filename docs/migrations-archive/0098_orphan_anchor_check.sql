-- =============================================================================
-- Migration 0098: Soft delete consistency check + orphan detection
-- Story: DB-AUDIT DR-5 — Soft delete inconsistency
-- Date: 2026-03-23
--
-- PURPOSE
-- -------
-- Anchors use soft delete (deleted_at) while profiles use Supabase Auth
-- cascading delete. The GDPR account deletion RPC (0065) handles this
-- correctly by anonymizing before cascade, but we need a safety net.
--
-- Fix: Create a check function that detects orphaned anchors (user_id
-- pointing to non-existent profile) and a cleanup function.
--
-- CHANGES
-- -------
-- 1. Create check_orphaned_anchors() diagnostic RPC
-- 2. Create cleanup_orphaned_anchors() maintenance RPC
-- =============================================================================

-- 1. Diagnostic: find anchors whose user_id references a deleted profile
CREATE OR REPLACE FUNCTION check_orphaned_anchors()
RETURNS TABLE(anchor_id uuid, user_id uuid, fingerprint text, status text, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
    SELECT a.id AS anchor_id, a.user_id, a.fingerprint, a.status::text, a.created_at
    FROM anchors a
    LEFT JOIN profiles p ON p.id = a.user_id
    WHERE p.id IS NULL
      AND a.deleted_at IS NULL
    ORDER BY a.created_at DESC
    LIMIT 100;
END;
$$;

-- 2. Cleanup: soft-delete orphaned anchors
CREATE OR REPLACE FUNCTION cleanup_orphaned_anchors()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cleaned integer;
BEGIN
  WITH orphans AS (
    UPDATE anchors a
    SET deleted_at = now()
    WHERE a.user_id NOT IN (SELECT id FROM profiles)
      AND a.deleted_at IS NULL
    RETURNING a.id
  )
  SELECT count(*) INTO cleaned FROM orphans;

  IF cleaned > 0 THEN
    INSERT INTO audit_events (event_type, event_category, actor_id, target_type, details)
    VALUES (
      'ORPHAN_CLEANUP',
      'SYSTEM',
      '00000000-0000-0000-0000-000000000000'::uuid,
      'anchor',
      format('Soft-deleted %s orphaned anchors', cleaned)
    );
  END IF;

  RETURN cleaned;
END;
$$;

-- Only service_role can run these
REVOKE EXECUTE ON FUNCTION check_orphaned_anchors() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION check_orphaned_anchors() TO service_role;
REVOKE EXECUTE ON FUNCTION cleanup_orphaned_anchors() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cleanup_orphaned_anchors() TO service_role;

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- DROP FUNCTION IF EXISTS cleanup_orphaned_anchors();
-- DROP FUNCTION IF EXISTS check_orphaned_anchors();
