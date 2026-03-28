-- Migration 0132: Add service_role bypass to prevent_metadata_edit_after_secured()
--
-- Problem: Pipeline fetchers (running as service_role) re-fetch records whose anchors
-- have already been SUBMITTED. The metadata trigger blocks their updates, flooding
-- Postgres logs with "Cannot modify metadata" errors (~100s/minute).
--
-- Fix: Allow service_role to update metadata on any anchor status, matching the
-- pattern used by protect_anchor_status_transition() (migration 0010/0125).
--
-- ROLLBACK: Restore function from migration 0124 (no service_role bypass)

CREATE OR REPLACE FUNCTION prevent_metadata_edit_after_secured()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  jwt_role text;
BEGIN
  -- No change to metadata or description — allow
  IF (OLD.metadata IS NOT DISTINCT FROM NEW.metadata)
     AND (OLD.description IS NOT DISTINCT FROM NEW.description) THEN
    RETURN NEW;
  END IF;

  -- Service role (worker/pipeline) can always update metadata
  jwt_role := current_setting('request.jwt.claims', true)::json->>'role';
  IF jwt_role = 'service_role' OR current_user = 'postgres' THEN
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

COMMENT ON FUNCTION prevent_metadata_edit_after_secured IS 'Prevents metadata/description edits on non-PENDING anchors for regular users. Service role (pipeline) is exempt.';
