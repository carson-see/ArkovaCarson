-- Migration: 0161_security_hardening_followup.sql
-- Description: Follow-up fixes for 7 code review issues on migration 0160.
--
-- Fixes:
--   CR-1: Revert activate_user anon REVOKE (breaks invite flow)
--   CR-3: Remove pg_temp from invite_member search_path
--   CR-4: Replace public_org_profiles VIEW with SECURITY DEFINER function (FORCE RLS bypass)
--   CR-5: (frontend-only — PaymentAnalyticsPage payer_address PII removal)
--   CR-7: Drop organizations_select_authenticated policy (EIN leak to all auth users)
--   BONUS: Re-add COMMENT ON FUNCTION for admin RPCs (wiped by CREATE OR REPLACE in 0160)
--   BONUS: Fix migration 0160 header (says 7 findings, implements 10)
--
-- ROLLBACK:
--   -- Re-create organizations_select_authenticated:
--   -- CREATE POLICY organizations_select_authenticated ON organizations FOR SELECT TO authenticated USING (true);
--   -- Revert activate_user grant:
--   -- REVOKE EXECUTE ON FUNCTION activate_user(text, text) FROM anon;
--   -- Drop get_public_org_profiles function:
--   -- DROP FUNCTION IF EXISTS get_public_org_profiles(uuid, integer, integer);

-- ============================================================================
-- CR-1: Restore activate_user anon access
-- Migration 0069 explicitly grants anon because users arrive via invite email
-- links BEFORE they have an account. Revoking breaks all invite onboarding.
-- ============================================================================

GRANT EXECUTE ON FUNCTION activate_user(text, text) TO anon;

-- ============================================================================
-- CR-3: Fix invite_member search_path — remove pg_temp
-- pg_temp in SECURITY DEFINER is a privilege escalation vector (temp table
-- shadowing). CLAUDE.md mandates SET search_path = public only.
-- ============================================================================

CREATE OR REPLACE FUNCTION invite_member(
  invitee_email text,
  invitee_role user_role,
  target_org_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
  -- Note: invitee_email in details is a known GDPR concern carried from 0061.
  -- Future migration should replace with invitation ID only.
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
-- CR-4: Replace public_org_profiles VIEW with SECURITY DEFINER function
-- The VIEW approach fails because organizations has FORCE ROW LEVEL SECURITY.
-- With the anon policy dropped (0160), the view returns 0 rows for anon callers.
-- A SECURITY DEFINER function bypasses RLS and returns only safe columns.
-- ============================================================================

DROP VIEW IF EXISTS public_org_profiles;

CREATE OR REPLACE FUNCTION get_public_org_profiles(
  p_org_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  display_name text,
  domain text,
  description text,
  website_url text,
  logo_url text,
  founded_date date,
  org_type text,
  linkedin_url text,
  twitter_url text,
  location text,
  industry_tag text,
  verification_status text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    o.id,
    o.display_name,
    o.domain,
    o.description,
    o.website_url,
    o.logo_url,
    o.founded_date,
    o.org_type,
    o.linkedin_url,
    o.twitter_url,
    o.location,
    o.industry_tag,
    o.verification_status,
    o.created_at
  FROM organizations o
  WHERE (p_org_id IS NULL OR o.id = p_org_id)
  ORDER BY o.created_at DESC
  LIMIT LEAST(p_limit, 100)
  OFFSET p_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION get_public_org_profiles(uuid, integer, integer) TO anon, authenticated, service_role;

-- ============================================================================
-- CR-7: Drop organizations_select_authenticated — EIN leak to all auth users
-- Migration 0153 added USING(true) for all authenticated, exposing ein_tax_id.
-- Authenticated users should use organizations_select_own (their own org only).
-- The onboarding org search should use the new get_public_org_profiles function.
-- ============================================================================

DROP POLICY IF EXISTS organizations_select_authenticated ON organizations;

-- ============================================================================
-- BONUS: Re-add COMMENT ON FUNCTION for admin RPCs
-- CREATE OR REPLACE in 0160 wiped the catalog comments from 0133.
-- ============================================================================

COMMENT ON FUNCTION admin_set_platform_admin IS 'Toggle is_platform_admin flag. Bypasses protective trigger. Service role only. Auth guard: service_role check (0160).';
COMMENT ON FUNCTION admin_change_user_role IS 'Change user role. Bypasses immutability trigger. Service role only. Auth guard: service_role check (0160).';
COMMENT ON FUNCTION admin_set_user_org IS 'Set user organization and org_members role. Bypasses protective triggers. Service role only. Auth guard: service_role check (0160).';
COMMENT ON FUNCTION invite_member IS 'Invite a member to an organization. ORG_ADMIN role blocked (0160). SET search_path = public only (0161).';
