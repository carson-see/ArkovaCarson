-- =============================================================================
-- Migration 0033: Fix profiles RLS for org member visibility + protect public_id
-- Story: Code review fixes for PR #4
-- Date: 2026-03-09
--
-- PURPOSE
-- -------
-- 1. Add RLS policy so org members can see each other's profiles.
--    Without this, profiles_select_own (auth.uid() = id) means the
--    MembersTable only ever returns the caller's own row.
-- 2. Protect public_id from post-create edits on profiles. The
--    protect_privileged_profile_fields() trigger does not guard
--    public_id, so users can overwrite or null their own public_id.
--
-- CHANGES
-- -------
-- 1. New RLS policy: profiles_select_org_members
-- 2. Updated trigger: protect_privileged_profile_fields() now guards public_id
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. RLS: Allow org members to see profiles within the same org
-- ---------------------------------------------------------------------------
-- Combined with existing profiles_select_own, this covers:
--   - Individual users see their own profile (profiles_select_own)
--   - Org members see all profiles in their org (profiles_select_org_members)

CREATE POLICY profiles_select_org_members ON profiles
  FOR SELECT
  TO authenticated
  USING (
    org_id IS NOT NULL
    AND org_id = get_user_org_id()
  );

COMMENT ON POLICY profiles_select_org_members ON profiles IS
  'Org members can view all profiles within their organization';


-- ---------------------------------------------------------------------------
-- 2. Protect public_id from user-initiated updates
-- ---------------------------------------------------------------------------
-- Recreate the trigger function with public_id guard added.
-- This is additive — all existing guards remain unchanged.

CREATE OR REPLACE FUNCTION protect_privileged_profile_fields()
RETURNS TRIGGER AS $$
DECLARE
  jwt_role text;
BEGIN
  -- Get the current role from JWT claims
  jwt_role := current_setting('request.jwt.claims', true)::json->>'role';

  -- Service role can modify any field
  IF jwt_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- For authenticated users, protect privileged fields
  IF OLD.org_id IS DISTINCT FROM NEW.org_id THEN
    RAISE EXCEPTION 'Cannot modify org_id directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.requires_manual_review IS DISTINCT FROM NEW.requires_manual_review THEN
    RAISE EXCEPTION 'Cannot modify requires_manual_review directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.manual_review_reason IS DISTINCT FROM NEW.manual_review_reason THEN
    RAISE EXCEPTION 'Cannot modify manual_review_reason directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.manual_review_completed_at IS DISTINCT FROM NEW.manual_review_completed_at THEN
    RAISE EXCEPTION 'Cannot modify manual_review_completed_at directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.manual_review_completed_by IS DISTINCT FROM NEW.manual_review_completed_by THEN
    RAISE EXCEPTION 'Cannot modify manual_review_completed_by directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.public_id IS DISTINCT FROM NEW.public_id THEN
    RAISE EXCEPTION 'Cannot modify public_id directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- No need to recreate trigger — protect_privileged_fields trigger already
-- references this function and will pick up the new definition.


-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- DROP POLICY IF EXISTS profiles_select_org_members ON profiles;
-- Then restore protect_privileged_profile_fields() WITHOUT the public_id guard
-- (see 0008_rls_profiles.sql for the original version)
