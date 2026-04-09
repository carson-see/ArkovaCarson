-- Migration 0180: Fix PostgREST v12 JWT claim format compatibility
--
-- PostgREST v12+ deprecated individual GUC settings (request.jwt.claim.role)
-- in favor of a single JSON claims setting (request.jwt.claims).
-- Supabase upgraded to PG 17.6 + PostgREST v12, breaking all functions that
-- checked request.jwt.claim.role directly.
--
-- This migration:
-- 1. Creates get_caller_role() helper that checks both formats
-- 2. Updates protect_anchor_status_transition trigger (batch anchoring was blocked)
-- 3. Updates prevent_direct_kyc_update trigger
-- 4. Updates admin_set_platform_admin, admin_change_user_role, admin_set_user_org
-- 5. Updates get_payment_ledger, get_anchor_tx_stats
-- 6. Fixes submit_batch_anchors WHERE clause to include PENDING status
-- 7. Fixes prevent_metadata_edit_after_secured to allow service_role bypass
--
-- Impact: Batch anchor processing was broken — 11,812 PENDING anchors accumulated
-- over 7 days while Bitcoin TXs were wasted every 2 minutes with 0 status updates.
--
-- Applied directly to production on 2026-04-09 (Session 38).
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS get_caller_role();
--   -- Then restore functions from 0179_security_audit_fixes.sql

-- ═══════════════════════════════════════════════════════════════════
-- Helper: get_caller_role() — works with both PostgREST < v12 and v12+
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_caller_role()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  role_val text;
  claims_json text;
BEGIN
  -- Try legacy GUC first (PostgREST < v12)
  role_val := current_setting('request.jwt.claim.role', true);
  IF role_val IS NOT NULL AND role_val != '' THEN
    RETURN role_val;
  END IF;

  -- Fall back to modern JSON claims (PostgREST v12+)
  claims_json := current_setting('request.jwt.claims', true);
  IF claims_json IS NOT NULL AND claims_json != '' THEN
    RETURN (claims_json::jsonb ->> 'role');
  END IF;

  RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION get_caller_role() TO authenticated;
GRANT EXECUTE ON FUNCTION get_caller_role() TO service_role;
GRANT EXECUTE ON FUNCTION get_caller_role() TO anon;

-- ═══════════════════════════════════════════════════════════════════
-- Fix protect_anchor_status_transition (CRITICAL — batch anchoring)
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION protect_anchor_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF get_caller_role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status != 'PENDING' THEN
      RAISE EXCEPTION 'New anchors must start in PENDING status';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    RAISE EXCEPTION 'Only the system can change anchor status (current: %, requested: %)',
      OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════
-- Fix prevent_direct_kyc_update
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION prevent_direct_kyc_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF get_caller_role() = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF OLD.identity_verification_status IS DISTINCT FROM NEW.identity_verification_status
    OR OLD.identity_verification_session_id IS DISTINCT FROM NEW.identity_verification_session_id
    OR OLD.identity_verified_at IS DISTINCT FROM NEW.identity_verified_at
    OR OLD.phone_verified_at IS DISTINCT FROM NEW.phone_verified_at
    OR OLD.kyc_provider IS DISTINCT FROM NEW.kyc_provider
  THEN
    RAISE EXCEPTION 'Identity verification fields can only be updated by the system';
  END IF;
  RETURN NEW;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════
-- Fix admin functions
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION admin_set_platform_admin(p_user_id uuid, p_is_admin boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF get_caller_role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied: service_role required';
  END IF;

  ALTER TABLE profiles DISABLE TRIGGER trg_protect_platform_admin;
  UPDATE profiles SET is_platform_admin = p_is_admin, updated_at = now() WHERE id = p_user_id;
  ALTER TABLE profiles ENABLE TRIGGER trg_protect_platform_admin;

  IF NOT FOUND THEN
    ALTER TABLE profiles ENABLE TRIGGER trg_protect_platform_admin;
    RAISE EXCEPTION 'User not found: %', p_user_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION admin_change_user_role(p_user_id uuid, p_new_role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF get_caller_role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied: service_role required';
  END IF;

  IF p_new_role NOT IN ('INDIVIDUAL', 'ORG_ADMIN', 'ORG_MEMBER') THEN
    RAISE EXCEPTION 'Invalid role: %. Must be INDIVIDUAL, ORG_ADMIN, or ORG_MEMBER', p_new_role;
  END IF;

  ALTER TABLE profiles DISABLE TRIGGER enforce_role_immutability;
  ALTER TABLE profiles DISABLE TRIGGER protect_privileged_fields;
  UPDATE profiles SET role = p_new_role::user_role, updated_at = now() WHERE id = p_user_id;
  ALTER TABLE profiles ENABLE TRIGGER enforce_role_immutability;
  ALTER TABLE profiles ENABLE TRIGGER protect_privileged_fields;

  IF NOT FOUND THEN
    ALTER TABLE profiles ENABLE TRIGGER enforce_role_immutability;
    ALTER TABLE profiles ENABLE TRIGGER protect_privileged_fields;
    RAISE EXCEPTION 'User not found: %', p_user_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION admin_set_user_org(p_user_id uuid, p_org_id uuid, p_org_role text DEFAULT 'member')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF get_caller_role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied: service_role required';
  END IF;

  IF p_org_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'Invalid org_role: %. Must be owner, admin, or member', p_org_role;
  END IF;

  IF p_org_id IS NOT NULL THEN
    PERFORM 1 FROM organizations WHERE id = p_org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Organization not found: %', p_org_id;
    END IF;
  END IF;

  ALTER TABLE profiles DISABLE TRIGGER protect_privileged_fields;
  UPDATE profiles SET org_id = p_org_id, updated_at = now() WHERE id = p_user_id;
  ALTER TABLE profiles ENABLE TRIGGER protect_privileged_fields;

  IF NOT FOUND THEN
    ALTER TABLE profiles ENABLE TRIGGER protect_privileged_fields;
    RAISE EXCEPTION 'User not found: %', p_user_id;
  END IF;

  IF p_org_id IS NOT NULL THEN
    INSERT INTO org_members (user_id, org_id, role)
    VALUES (p_user_id, p_org_id, p_org_role::org_member_role)
    ON CONFLICT (user_id, org_id) DO UPDATE SET role = p_org_role::org_member_role;
  ELSE
    DELETE FROM org_members WHERE user_id = p_user_id;
  END IF;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════
-- Fix get_payment_ledger and get_anchor_tx_stats
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_payment_ledger(p_limit int DEFAULT 50, p_offset int DEFAULT 0)
RETURNS SETOF payment_ledger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    get_caller_role() = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN
    RAISE EXCEPTION 'Access denied: platform admin required';
  END IF;

  RETURN QUERY
  SELECT * FROM payment_ledger
  ORDER BY event_at DESC
  LIMIT LEAST(p_limit, 100)
  OFFSET p_offset;
END;
$$;

CREATE OR REPLACE FUNCTION get_anchor_tx_stats()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    get_caller_role() = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN
    RAISE EXCEPTION 'Access denied: platform admin required';
  END IF;

  RETURN (
    SELECT json_build_object(
      'distinct_tx_count', (SELECT count(DISTINCT bitcoin_txid) FROM anchors WHERE bitcoin_txid IS NOT NULL),
      'anchors_with_tx', (SELECT count(*) FROM anchors WHERE bitcoin_txid IS NOT NULL),
      'total_anchors', (SELECT count(*) FROM anchors WHERE deleted_at IS NULL),
      'last_anchor_time', (SELECT max(created_at) FROM anchors WHERE deleted_at IS NULL),
      'last_tx_time', (SELECT max(anchored_at) FROM anchors WHERE anchored_at IS NOT NULL)
    )
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════
-- Fix submit_batch_anchors WHERE clause (was only matching BROADCASTING)
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION submit_batch_anchors(
  p_anchor_ids uuid[],
  p_tx_id text,
  p_block_height bigint DEFAULT NULL,
  p_block_timestamp timestamptz DEFAULT NULL,
  p_merkle_root text DEFAULT NULL,
  p_batch_id text DEFAULT NULL
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout TO '60s'
AS $$
DECLARE cnt int;
BEGIN
  UPDATE anchors
  SET status = 'SUBMITTED',
    chain_tx_id = p_tx_id,
    chain_block_height = p_block_height,
    chain_timestamp = p_block_timestamp,
    updated_at = now(),
    metadata = COALESCE(metadata, '{}'::jsonb)
      - '_claimed_by' - '_claimed_at'
      || jsonb_build_object('merkle_root', p_merkle_root, 'batch_id', p_batch_id)
  WHERE id = ANY(p_anchor_ids)
    AND status IN ('BROADCASTING', 'PENDING');
  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════
-- Fix prevent_metadata_edit_after_secured — allow service_role bypass
-- The batch anchor pipeline modifies metadata (merkle_root, batch_id)
-- after status changes from PENDING to BROADCASTING/SUBMITTED.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION prevent_metadata_edit_after_secured()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Allow service_role to modify metadata (worker batch processing)
  IF get_caller_role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Allow if neither metadata nor description changed
  IF (OLD.metadata IS NOT DISTINCT FROM NEW.metadata)
     AND (OLD.description IS NOT DISTINCT FROM NEW.description)
  THEN
    RETURN NEW;
  END IF;

  -- Block changes when status is not PENDING
  IF OLD.status != 'PENDING' THEN
    -- Allow setting description for the first time (NULL -> value) for backfill
    IF OLD.description IS NULL AND NEW.description IS NOT NULL
       AND (OLD.metadata IS NOT DISTINCT FROM NEW.metadata)
    THEN
      RETURN NEW;
    END IF;

    IF OLD.metadata IS DISTINCT FROM NEW.metadata THEN
      RAISE EXCEPTION 'Cannot modify metadata after anchor has been secured. Current status: %', OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.description IS DISTINCT FROM NEW.description THEN
      RAISE EXCEPTION 'Cannot modify description after anchor has been secured. Current status: %', OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
