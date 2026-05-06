-- Migration 0125: Mainnet operational fixes
--
-- Applied directly to production during mainnet migration session.
-- This migration captures those changes for local dev parity.
--
-- Changes:
-- 1. protect_anchor_status_transition: Allow current_user='postgres' bypass
--    (needed for SECURITY DEFINER functions like claim_pending_anchors)
-- 2. authenticator role: Increase statement_timeout from 30s to 60s
--    (PostgREST schema cache introspection was timing out on large schemas)
-- 3. pg_cron extension for scheduled maintenance
-- 4. Hourly VACUUM schedule for anchors table
--
-- ROLLBACK:
--   ALTER ROLE authenticator SET statement_timeout = '30s';
--   Remove 'IF current_user = ''postgres'' THEN RETURN NEW; END IF;' from trigger

-- 1. Fix protect_anchor_status_transition to allow SECURITY DEFINER bypass
CREATE OR REPLACE FUNCTION protect_anchor_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  jwt_role text;
BEGIN
  -- Allow postgres user (used by SECURITY DEFINER functions like claim_pending_anchors)
  IF current_user = 'postgres' THEN RETURN NEW; END IF;

  jwt_role := current_setting('request.jwt.claims', true)::json->>'role';
  IF jwt_role = 'service_role' THEN RETURN NEW; END IF;

  IF OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'Cannot change anchor owner' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.status != 'SECURED' AND NEW.status = 'SECURED' THEN
    RAISE EXCEPTION 'Cannot set status to SECURED directly' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status != 'SUBMITTED' AND NEW.status = 'SUBMITTED' THEN
    RAISE EXCEPTION 'Cannot set status to SUBMITTED directly' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status != 'BROADCASTING' AND NEW.status = 'BROADCASTING' THEN
    RAISE EXCEPTION 'Cannot set status to BROADCASTING directly' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.chain_tx_id IS DISTINCT FROM NEW.chain_tx_id
     OR OLD.chain_block_height IS DISTINCT FROM NEW.chain_block_height
     OR OLD.chain_timestamp IS DISTINCT FROM NEW.chain_timestamp
     OR OLD.chain_confirmations IS DISTINCT FROM NEW.chain_confirmations THEN
    RAISE EXCEPTION 'Cannot modify chain data directly' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.revocation_tx_id IS DISTINCT FROM NEW.revocation_tx_id
     OR OLD.revocation_block_height IS DISTINCT FROM NEW.revocation_block_height THEN
    RAISE EXCEPTION 'Cannot modify revocation chain data directly' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.legal_hold IS DISTINCT FROM NEW.legal_hold THEN
    RAISE EXCEPTION 'Cannot modify legal_hold directly' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.parent_anchor_id IS DISTINCT FROM NEW.parent_anchor_id THEN
    RAISE EXCEPTION 'Cannot modify parent_anchor_id directly' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.version_number IS DISTINCT FROM NEW.version_number THEN
    RAISE EXCEPTION 'Cannot modify version_number directly' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF (OLD.status IN ('SECURED', 'SUBMITTED', 'BROADCASTING', 'REVOKED'))
     AND OLD.description IS DISTINCT FROM NEW.description THEN
    RAISE EXCEPTION 'Cannot modify description after anchor is secured' USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

-- 2. Increase authenticator statement_timeout for PostgREST schema cache
ALTER ROLE authenticator SET statement_timeout = '60s';

-- 3. Enable pg_cron for scheduled maintenance
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- 4. Schedule hourly VACUUM for anchors table (avoids autovacuum blocking PostgREST)
SELECT cron.schedule('vacuum-anchors', '3 * * * *', 'VACUUM anchors');
