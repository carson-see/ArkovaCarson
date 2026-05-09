-- Migration 0124: Fix anchor triggers and RPC timeouts for mainnet anchoring
--
-- Fixes:
-- 1. prevent_metadata_edit_after_secured() — allow metadata changes when status is also changing
--    (needed for BROADCASTING → PENDING recovery and PENDING → BROADCASTING claiming)
-- 2. claim_pending_anchors() — increase statement_timeout from 30s to 60s for 55K+ rows
-- 3. recover_stuck_broadcasts() — increase statement_timeout to 60s
--
-- ROLLBACK: Restore original prevent_metadata_edit_after_secured() that only allows PENDING edits

-- Fix prevent_metadata_edit_after_secured to allow metadata changes during status transitions
CREATE OR REPLACE FUNCTION prevent_metadata_edit_after_secured()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- No change to metadata or description — allow
  IF (OLD.metadata IS NOT DISTINCT FROM NEW.metadata)
     AND (OLD.description IS NOT DISTINCT FROM NEW.description) THEN
    RETURN NEW;
  END IF;

  -- Allow metadata changes on PENDING anchors
  IF OLD.status = 'PENDING' THEN
    RETURN NEW;
  END IF;

  -- Allow metadata changes when status is also changing (recovery, claiming, submission)
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  -- Block metadata/description changes on non-PENDING anchors with no status change
  IF OLD.metadata IS DISTINCT FROM NEW.metadata THEN
    RAISE EXCEPTION 'Cannot modify metadata after anchor has been secured, revoked, or expired. Current status: %', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.description IS DISTINCT FROM NEW.description THEN
    RAISE EXCEPTION 'Cannot modify description after anchor has been secured, revoked, or expired. Current status: %', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- Recreate claim_pending_anchors with 60s timeout
CREATE OR REPLACE FUNCTION claim_pending_anchors(
  p_worker_id text DEFAULT 'worker-1',
  p_limit integer DEFAULT 50,
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
    claimed.id, claimed.user_id, claimed.org_id,
    claimed.fingerprint::text, claimed.public_id,
    claimed.metadata, claimed.credential_type::text
  FROM claimed;
END;
$$;

-- Recreate recover_stuck_broadcasts with 60s timeout
CREATE OR REPLACE FUNCTION recover_stuck_broadcasts(
  p_stale_minutes integer DEFAULT 5
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
SET statement_timeout TO '60s'
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
        AND a2.chain_tx_id IS NULL
      FOR UPDATE SKIP LOCKED
    )
    RETURNING a.id, a.fingerprint::text, a.metadata->>'_previous_claimed_by' AS claimed_by, a.updated_at
  )
  SELECT stuck.id, stuck.fingerprint, stuck.claimed_by, stuck.updated_at
  FROM stuck;
END;
$$;
