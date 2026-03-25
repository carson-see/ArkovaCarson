-- =============================================================================
-- Migration 0111: Atomic anchor claim RPC + stuck broadcast recovery
-- Story: RACE-1 — Prevent double-broadcast on worker crash
-- Date: 2026-03-24
--
-- PURPOSE
-- -------
-- The double-broadcast vulnerability: if a worker crashes between calling
-- chainClient.submitFingerprint() and updating status to SUBMITTED, the
-- anchor stays PENDING and gets re-broadcast on restart, burning treasury sats.
--
-- Fix: Two-phase claim pattern using FOR UPDATE SKIP LOCKED.
--   1. claim_pending_anchors() atomically sets PENDING → BROADCASTING
--   2. Worker broadcasts to chain
--   3. Worker updates BROADCASTING → SUBMITTED with chain_tx_id
--
-- Recovery: recover_stuck_broadcasts() finds anchors stuck in BROADCASTING
-- for >5 minutes and resets them to PENDING for retry.
--
-- CHANGES
-- -------
-- 1. Create claim_pending_anchors() RPC (atomic claim with row lock)
-- 2. Create recover_stuck_broadcasts() RPC (orphan recovery)
-- 3. Create index on BROADCASTING status for recovery query
-- 4. Update protect_anchor_status_transition() to allow BROADCASTING
-- =============================================================================

-- 1. Atomic claim: PENDING → BROADCASTING with FOR UPDATE SKIP LOCKED
-- Returns the claimed anchors so the worker can process them.
-- p_worker_id: identifier for the claiming worker (for diagnostics)
-- p_limit: max anchors to claim per batch
-- p_exclude_pipeline: when true, excludes pipeline records (default true)
CREATE OR REPLACE FUNCTION claim_pending_anchors(
  p_worker_id text DEFAULT 'worker-1',
  p_limit int DEFAULT 50,
  p_exclude_pipeline boolean DEFAULT true
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
        AND (
          NOT p_exclude_pipeline
          OR (a2.metadata->>'pipeline_source') IS NULL
        )
      ORDER BY a2.created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT p_limit
    )
    RETURNING a.*
  )
  SELECT
    claimed.id,
    claimed.user_id,
    claimed.org_id,
    claimed.fingerprint,
    claimed.public_id,
    claimed.metadata,
    claimed.credential_type::text
  FROM claimed;
END;
$$;

-- 2. Recovery: find BROADCASTING anchors older than threshold and reset to PENDING.
-- p_stale_minutes: how many minutes before a BROADCASTING anchor is considered stuck
-- Returns count of recovered anchors.
CREATE OR REPLACE FUNCTION recover_stuck_broadcasts(
  p_stale_minutes int DEFAULT 5
)
RETURNS TABLE(
  anchor_id uuid,
  anchor_fingerprint text,
  claimed_by text,
  stuck_since timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH stuck AS (
    UPDATE anchors a
    SET
      status = 'PENDING',
      updated_at = now(),
      metadata = COALESCE(a.metadata, '{}'::jsonb)
        || jsonb_build_object(
          '_recovery_reason', 'stuck_broadcasting',
          '_recovered_at', now()::text,
          '_previous_claimed_by', COALESCE(a.metadata->>'_claimed_by', 'unknown')
        )
        - '_claimed_by'
        - '_claimed_at'
    WHERE a.id IN (
      SELECT a2.id
      FROM anchors a2
      WHERE a2.status = 'BROADCASTING'
        AND a2.updated_at < now() - (p_stale_minutes || ' minutes')::interval
        AND a2.deleted_at IS NULL
        -- Only reset if NO chain_tx_id was recorded (broadcast didn't complete)
        AND a2.chain_tx_id IS NULL
      FOR UPDATE SKIP LOCKED
    )
    RETURNING a.id, a.fingerprint, a.metadata->>'_previous_claimed_by' AS claimed_by, a.updated_at
  )
  SELECT stuck.id, stuck.fingerprint, stuck.claimed_by, stuck.updated_at
  FROM stuck;
END;
$$;

-- 3. Index for recovery query: find BROADCASTING anchors efficiently
CREATE INDEX IF NOT EXISTS idx_anchors_broadcasting_status
  ON anchors (status, updated_at) WHERE status = 'BROADCASTING';

-- 4. Update status transition trigger to allow BROADCASTING (worker-only)
CREATE OR REPLACE FUNCTION protect_anchor_status_transition()
RETURNS TRIGGER AS $$
DECLARE
  jwt_role text;
BEGIN
  -- Get the current role from JWT claims
  jwt_role := current_setting('request.jwt.claims', true)::json->>'role';

  -- Service role can do anything
  IF jwt_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Users cannot change user_id
  IF OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'Cannot change anchor owner'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Users cannot set status to SECURED, SUBMITTED, or BROADCASTING directly (only system can)
  IF OLD.status != 'SECURED' AND NEW.status = 'SECURED' THEN
    RAISE EXCEPTION 'Cannot set status to SECURED directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.status != 'SUBMITTED' AND NEW.status = 'SUBMITTED' THEN
    RAISE EXCEPTION 'Cannot set status to SUBMITTED directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.status != 'BROADCASTING' AND NEW.status = 'BROADCASTING' THEN
    RAISE EXCEPTION 'Cannot set status to BROADCASTING directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Users cannot modify chain data
  IF OLD.chain_tx_id IS DISTINCT FROM NEW.chain_tx_id
     OR OLD.chain_block_height IS DISTINCT FROM NEW.chain_block_height
     OR OLD.chain_timestamp IS DISTINCT FROM NEW.chain_timestamp
     OR OLD.chain_confirmations IS DISTINCT FROM NEW.chain_confirmations THEN
    RAISE EXCEPTION 'Cannot modify chain data directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Users cannot modify revocation chain data
  IF OLD.revocation_tx_id IS DISTINCT FROM NEW.revocation_tx_id
     OR OLD.revocation_block_height IS DISTINCT FROM NEW.revocation_block_height THEN
    RAISE EXCEPTION 'Cannot modify revocation chain data directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Users cannot modify legal_hold
  IF OLD.legal_hold IS DISTINCT FROM NEW.legal_hold THEN
    RAISE EXCEPTION 'Cannot modify legal_hold directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Users cannot modify lineage fields (set by trigger on INSERT only)
  IF OLD.parent_anchor_id IS DISTINCT FROM NEW.parent_anchor_id THEN
    RAISE EXCEPTION 'Cannot modify parent_anchor_id directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.version_number IS DISTINCT FROM NEW.version_number THEN
    RAISE EXCEPTION 'Cannot modify version_number directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Description is immutable after SECURED, SUBMITTED, or BROADCASTING
  IF (OLD.status IN ('SECURED', 'SUBMITTED', 'BROADCASTING', 'REVOKED'))
     AND OLD.description IS DISTINCT FROM NEW.description THEN
    RAISE EXCEPTION 'Cannot modify description after anchor is secured'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Only service_role can run these RPCs
REVOKE EXECUTE ON FUNCTION claim_pending_anchors(text, int, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_pending_anchors(text, int, boolean) TO service_role;
REVOKE EXECUTE ON FUNCTION recover_stuck_broadcasts(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recover_stuck_broadcasts(int) TO service_role;

-- =============================================================================
-- ROLLBACK
-- =============================================================================
-- DROP FUNCTION IF EXISTS claim_pending_anchors(text, int, boolean);
-- DROP FUNCTION IF EXISTS recover_stuck_broadcasts(int);
-- DROP INDEX IF EXISTS idx_anchors_broadcasting_status;
-- Restore protect_anchor_status_transition() from 0068b
