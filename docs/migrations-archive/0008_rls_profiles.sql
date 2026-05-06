-- Migration: 0008_rls_profiles.sql
-- Description: RLS policies for profiles table
-- Rollback: DROP POLICY IF EXISTS profiles_select_own ON profiles; DROP POLICY IF EXISTS profiles_update_own ON profiles;

-- =============================================================================
-- SELECT POLICY: Users can read their own profile
-- =============================================================================

CREATE POLICY profiles_select_own ON profiles
  FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

-- =============================================================================
-- INSERT POLICY: Profile creation handled by auth triggers/functions
-- Users should not insert their own profiles directly (handled by system)
-- =============================================================================

-- No INSERT policy for regular users
-- Profile creation should be handled by auth hooks or admin functions

-- =============================================================================
-- UPDATE POLICY: Users can update their own profile (non-privileged fields only)
-- =============================================================================

-- Policy allows update, but privileged fields are protected by trigger
CREATE POLICY profiles_update_own ON profiles
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- =============================================================================
-- TRIGGER: Prevent direct update of privileged fields
-- =============================================================================

-- This trigger checks if the caller is service_role (via JWT claims)
-- Service role can modify any field; authenticated users cannot modify privileged fields
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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER protect_privileged_fields
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION protect_privileged_profile_fields();

-- Comments
COMMENT ON POLICY profiles_select_own ON profiles IS 'Users can only read their own profile';
COMMENT ON POLICY profiles_update_own ON profiles IS 'Users can update their own profile (privileged fields protected by trigger)';
