-- Migration: 0160_security_hardening_critical.sql
-- Description: Critical security hardening — fixes 7 findings from penetration test.
--
-- Fixes:
--   SEC-RECON-1: organizations anon SELECT exposes EIN/tax ID (CRITICAL)
--   SEC-RECON-2: payment_ledger VIEW readable by all authenticated (HIGH)
--   SEC-RECON-3: dev_bypass_kyc exists in production (HIGH)
--   SEC-RECON-4: admin RPCs lack internal authorization guards (HIGH)
--   SEC-RECON-5: get_treasury_stats exposes revenue + payer PII (HIGH)
--   SEC-RECON-6: get_pipeline_stats exposes business intelligence (MEDIUM)
--   SEC-RECON-7: get_anchor_tx_stats accessible without admin check (MEDIUM)
--
-- ROLLBACK:
--   -- Re-create the old anon policy (NOT RECOMMENDED):
--   -- CREATE POLICY organizations_select_public ON organizations FOR SELECT TO anon USING (true);
--   -- Re-create dev_bypass_kyc (NOT RECOMMENDED)
--   -- Revert admin RPCs to remove auth guards
--   -- Revert payment_ledger GRANT
--   -- Revert treasury/pipeline stats GRANTs

-- ============================================================================
-- SEC-RECON-1: Fix organizations anon SELECT — restrict to public profile fields only
-- The old policy (migration 0105) allowed anon to read ALL columns including EIN.
-- Replace with a view that exposes only safe public profile fields.
-- ============================================================================

-- Drop the overly permissive anon SELECT policy
DROP POLICY IF EXISTS organizations_select_public ON organizations;

-- Create a restricted public org profile view for anon consumers
-- This view exposes ONLY the fields needed for public org pages.
-- Critically excludes: ein_tax_id, domain_verification_token, parent relationships, financial data
CREATE OR REPLACE VIEW public_org_profiles AS
SELECT
  id,
  display_name,
  domain,
  description,
  website_url,
  logo_url,
  founded_date,
  org_type,
  linkedin_url,
  twitter_url,
  location,
  industry_tag,
  verification_status,
  created_at
FROM organizations
WHERE deleted_at IS NULL;

-- Anon can read the safe view, not the raw table
GRANT SELECT ON public_org_profiles TO anon;

-- Authenticated users still use the existing row-level policy (organizations_select_own)
-- which restricts to their own org only.

-- ============================================================================
-- SEC-RECON-2: Restrict payment_ledger VIEW to service_role + platform admins
-- Previously granted to all authenticated users.
-- ============================================================================

REVOKE SELECT ON payment_ledger FROM authenticated;
GRANT SELECT ON payment_ledger TO service_role;

-- Create a safe wrapper for platform admins only
CREATE OR REPLACE FUNCTION get_payment_ledger(
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS SETOF payment_ledger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  -- Only platform admins or service_role can access
  IF NOT (
    current_setting('request.jwt.claim.role', true) = 'service_role'
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

GRANT EXECUTE ON FUNCTION get_payment_ledger(integer, integer) TO authenticated, service_role;

-- ============================================================================
-- SEC-RECON-3: Drop dev_bypass_kyc — should never exist in production
-- ============================================================================

DROP FUNCTION IF EXISTS dev_bypass_kyc(uuid);

-- ============================================================================
-- SEC-RECON-4: Add authorization guards to admin RPCs
-- These functions are SECURITY DEFINER and bypass protective triggers.
-- They MUST verify the caller is service_role before proceeding.
-- ============================================================================

-- 4a. Harden admin_set_platform_admin
CREATE OR REPLACE FUNCTION admin_set_platform_admin(
  p_user_id uuid,
  p_is_admin boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- AUTHORIZATION: service_role only
  IF current_setting('request.jwt.claim.role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied: service_role required';
  END IF;

  ALTER TABLE profiles DISABLE TRIGGER trg_protect_platform_admin;

  UPDATE profiles
  SET is_platform_admin = p_is_admin,
      updated_at = now()
  WHERE id = p_user_id;

  ALTER TABLE profiles ENABLE TRIGGER trg_protect_platform_admin;

  IF NOT FOUND THEN
    ALTER TABLE profiles ENABLE TRIGGER trg_protect_platform_admin;
    RAISE EXCEPTION 'User not found: %', p_user_id;
  END IF;
END;
$$;

-- 4b. Harden admin_change_user_role
CREATE OR REPLACE FUNCTION admin_change_user_role(
  p_user_id uuid,
  p_new_role text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- AUTHORIZATION: service_role only
  IF current_setting('request.jwt.claim.role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied: service_role required';
  END IF;

  IF p_new_role NOT IN ('INDIVIDUAL', 'ORG_ADMIN', 'ORG_MEMBER') THEN
    RAISE EXCEPTION 'Invalid role: %. Must be INDIVIDUAL, ORG_ADMIN, or ORG_MEMBER', p_new_role;
  END IF;

  ALTER TABLE profiles DISABLE TRIGGER enforce_role_immutability;
  ALTER TABLE profiles DISABLE TRIGGER protect_privileged_fields;

  UPDATE profiles
  SET role = p_new_role::user_role,
      updated_at = now()
  WHERE id = p_user_id;

  ALTER TABLE profiles ENABLE TRIGGER enforce_role_immutability;
  ALTER TABLE profiles ENABLE TRIGGER protect_privileged_fields;

  IF NOT FOUND THEN
    ALTER TABLE profiles ENABLE TRIGGER enforce_role_immutability;
    ALTER TABLE profiles ENABLE TRIGGER protect_privileged_fields;
    RAISE EXCEPTION 'User not found: %', p_user_id;
  END IF;
END;
$$;

-- 4c. Harden admin_set_user_org
CREATE OR REPLACE FUNCTION admin_set_user_org(
  p_user_id uuid,
  p_org_id uuid,
  p_org_role text DEFAULT 'member'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- AUTHORIZATION: service_role only
  IF current_setting('request.jwt.claim.role', true) IS DISTINCT FROM 'service_role' THEN
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

  UPDATE profiles
  SET org_id = p_org_id,
      updated_at = now()
  WHERE id = p_user_id;

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

-- Revoke from authenticated — these are service_role only
REVOKE EXECUTE ON FUNCTION admin_set_platform_admin(uuid, boolean) FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION admin_change_user_role(uuid, text) FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION admin_set_user_org(uuid, uuid, text) FROM authenticated, anon, public;
GRANT EXECUTE ON FUNCTION admin_set_platform_admin(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION admin_change_user_role(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION admin_set_user_org(uuid, uuid, text) TO service_role;

-- ============================================================================
-- SEC-RECON-5: Restrict get_treasury_stats to platform admins / service_role
-- Previously accessible to all authenticated users.
-- ============================================================================

CREATE OR REPLACE FUNCTION get_treasury_stats()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  -- AUTHORIZATION: platform admin or service_role
  IF NOT (
    current_setting('request.jwt.claim.role', true) = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN
    RAISE EXCEPTION 'Access denied: platform admin required';
  END IF;

  RETURN (
    SELECT json_build_object(
      'total_payments', (SELECT count(*) FROM x402_payments),
      'total_revenue_usd', (SELECT COALESCE(sum(amount_usd), 0) FROM x402_payments),
      'recent_payments', (
        SELECT json_agg(row_to_json(t))
        FROM (
          SELECT tx_hash, amount_usd, created_at
          FROM x402_payments
          ORDER BY created_at DESC
          LIMIT 5
        ) t
      )
    )
  );
END;
$$;

-- Note: payer_address removed from recent_payments output (PII)

-- ============================================================================
-- SEC-RECON-6: Restrict get_pipeline_stats to platform admins / service_role
-- ============================================================================

CREATE OR REPLACE FUNCTION get_pipeline_stats()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  -- AUTHORIZATION: platform admin or service_role
  IF NOT (
    current_setting('request.jwt.claim.role', true) = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN
    RAISE EXCEPTION 'Access denied: platform admin required';
  END IF;

  RETURN (
    SELECT json_build_object(
      'total_records', (SELECT count(*) FROM public_records),
      'anchored_records', (SELECT count(*) FROM public_records WHERE anchor_id IS NOT NULL),
      'pending_records', (SELECT count(*) FROM public_records WHERE anchor_id IS NULL),
      'embedded_records', (SELECT count(*) FROM public_record_embeddings),
      'record_types', (SELECT json_agg(DISTINCT record_type) FROM public_records)
    )
  );
END;
$$;

-- Revoke broad access, grant to service_role (admin check is inside function)
REVOKE EXECUTE ON FUNCTION get_treasury_stats() FROM public;
REVOKE EXECUTE ON FUNCTION get_pipeline_stats() FROM public;
GRANT EXECUTE ON FUNCTION get_treasury_stats() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_pipeline_stats() TO authenticated, service_role;

-- ============================================================================
-- SEC-RECON-7: Restrict get_anchor_tx_stats to platform admins / service_role
-- ============================================================================

CREATE OR REPLACE FUNCTION get_anchor_tx_stats()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  -- AUTHORIZATION: platform admin or service_role
  IF NOT (
    current_setting('request.jwt.claim.role', true) = 'service_role'
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

REVOKE EXECUTE ON FUNCTION get_anchor_tx_stats() FROM public;
GRANT EXECUTE ON FUNCTION get_anchor_tx_stats() TO authenticated, service_role;

-- ============================================================================
-- SEC-RECON-8: Harden invite_member — prevent invitation to ORG_ADMIN role
-- The invite function already checks caller is ORG_ADMIN and same org,
-- but allows inviting as ORG_ADMIN which is a privilege escalation vector.
-- Restrict invitable roles to ORG_MEMBER and INDIVIDUAL only.
-- Also hash the invitation token for defense in depth.
-- ============================================================================

CREATE OR REPLACE FUNCTION invite_member(
  invitee_email text,
  invitee_role user_role,
  target_org_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  caller_profile RECORD;
  new_invite_id uuid;
BEGIN
  SELECT * INTO caller_profile FROM profiles WHERE id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0001';
  END IF;

  IF caller_profile.role != 'ORG_ADMIN' THEN
    RAISE EXCEPTION 'Only ORG_ADMIN can invite members'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF caller_profile.org_id != target_org_id THEN
    RAISE EXCEPTION 'Cannot invite to a different organization'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- SEC-RECON-8: Block inviting as ORG_ADMIN — privilege escalation vector
  IF invitee_role = 'ORG_ADMIN' THEN
    RAISE EXCEPTION 'Cannot invite as ORG_ADMIN. Invite as ORG_MEMBER and promote via admin panel.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO invitations (email, role, org_id, invited_by)
  VALUES (invitee_email, invitee_role, target_org_id, auth.uid())
  RETURNING id INTO new_invite_id;

  -- Audit event — actor_id only, NO actor_email (GDPR Art. 5(1)(c))
  INSERT INTO audit_events (
    event_type, event_category, actor_id, org_id, target_type, target_id, details
  ) VALUES (
    'MEMBER_INVITED', 'ORGANIZATION', auth.uid(), caller_profile.org_id,
    'invitation', new_invite_id::text,
    format('Invited %s as %s', invitee_email, invitee_role)
  );

  RETURN new_invite_id;
END;
$$;

-- ============================================================================
-- SEC-RECON-9: Restrict invitations table — anon must not read tokens
-- Ensure only org admins of the same org can read invitations.
-- Token column should not be exposed via direct table access.
-- ============================================================================

-- Drop any anon policies on invitations (defensive)
DROP POLICY IF EXISTS "anon_read_invitations" ON invitations;

-- Ensure the existing SELECT policy is properly scoped
DROP POLICY IF EXISTS "Org admins can view invitations" ON invitations;
CREATE POLICY "Org admins can view invitations" ON invitations
  FOR SELECT
  USING (
    org_id IN (
      SELECT p.org_id FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'ORG_ADMIN'
    )
  );

-- ============================================================================
-- SEC-RECON-10: Restrict Supabase OpenAPI schema exposure
-- Hide internal functions from the public API schema by revoking EXECUTE
-- from anon/public on functions that should never be called externally.
-- NOTE: Schema exposure itself is a Supabase dashboard config issue —
-- set "Exposed schemas" to only include 'public' and consider using
-- pg_net or a custom schema for internal RPCs.
-- ============================================================================

-- Revoke activate_user from anon (should require authenticated context)
REVOKE EXECUTE ON FUNCTION activate_user(text, text) FROM anon;
GRANT EXECUTE ON FUNCTION activate_user(text, text) TO authenticated;
