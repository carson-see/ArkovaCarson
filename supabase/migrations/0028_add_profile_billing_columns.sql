-- Migration: 0028_add_profile_billing_columns.sql
-- Story: P2-TS-05 (G-11, G-12)
-- Description: Add is_verified and subscription_tier columns to profiles,
--   then update protect_privileged_profile_fields() trigger to guard them.
--
-- ROLLBACK:
-- ALTER TABLE profiles DROP COLUMN IF EXISTS is_verified;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS subscription_tier;
-- Then re-run 0008_rls_profiles.sql trigger definition to restore previous version.

-- =============================================================================
-- 1. ADD COLUMNS
-- =============================================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS subscription_tier TEXT NOT NULL DEFAULT 'free';

-- Add constraint: subscription_tier must be one of the known tiers
ALTER TABLE profiles
  ADD CONSTRAINT profiles_subscription_tier_check
  CHECK (subscription_tier IN ('free', 'starter', 'professional', 'enterprise'));

COMMENT ON COLUMN profiles.is_verified IS 'Whether the user identity has been verified by an admin. Only settable by service_role.';
COMMENT ON COLUMN profiles.subscription_tier IS 'Current billing tier. Only settable by service_role via billing system.';

-- =============================================================================
-- 2. UPDATE TRIGGER to protect the new columns
-- =============================================================================

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

  IF OLD.is_verified IS DISTINCT FROM NEW.is_verified THEN
    RAISE EXCEPTION 'Cannot modify is_verified directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.subscription_tier IS DISTINCT FROM NEW.subscription_tier THEN
    RAISE EXCEPTION 'Cannot modify subscription_tier directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger already exists from 0008 — CREATE OR REPLACE above replaces the function body.
-- The existing trigger binding (protect_privileged_fields BEFORE UPDATE) still fires
-- the same function name, so no need to DROP/re-CREATE the trigger itself.
