-- IDT Phase D: Identity verification fields for KYC via Stripe Identity (IDT-03)
-- Adds identity verification tracking columns to profiles table.

-- Stripe Identity verification session tracking
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS phone_number text DEFAULT NULL;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS identity_verification_status text DEFAULT 'unstarted'
    CHECK (identity_verification_status IN ('unstarted', 'pending', 'verified', 'requires_input', 'canceled'));

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS identity_verification_session_id text DEFAULT NULL;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS identity_verified_at timestamptz DEFAULT NULL;

-- Phone number E.164 format constraint (optional field)
ALTER TABLE profiles
  ADD CONSTRAINT profiles_phone_e164 CHECK (
    phone_number IS NULL OR phone_number ~ '^\+[1-9]\d{1,14}$'
  );

-- Index for admin queries on verification status
CREATE INDEX IF NOT EXISTS idx_profiles_identity_verification_status
  ON profiles (identity_verification_status)
  WHERE identity_verification_status != 'unstarted';

-- RLS: existing profiles policies cover these columns (row-level, not column-level).
-- The identity_verification_session_id should only be written by service_role (worker webhook).
-- Users can read their own row but cannot update verification fields directly.

-- Revoke direct update on verification columns from authenticated users
-- (updates come via worker webhook with service_role only)
CREATE OR REPLACE FUNCTION prevent_direct_kyc_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Allow service_role to update anything
  IF current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- For regular users, prevent changing verification fields
  IF OLD.identity_verification_status IS DISTINCT FROM NEW.identity_verification_status
    OR OLD.identity_verification_session_id IS DISTINCT FROM NEW.identity_verification_session_id
    OR OLD.identity_verified_at IS DISTINCT FROM NEW.identity_verified_at
  THEN
    RAISE EXCEPTION 'Identity verification fields can only be updated by the system';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_prevent_direct_kyc_update
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION prevent_direct_kyc_update();

COMMENT ON COLUMN profiles.phone_number IS 'User phone number in E.164 format, optional (IDT-03)';
COMMENT ON COLUMN profiles.identity_verification_status IS 'Stripe Identity verification status: unstarted, pending, verified, requires_input, canceled (IDT-03)';
COMMENT ON COLUMN profiles.identity_verification_session_id IS 'Stripe Identity VerificationSession ID (IDT-03)';
COMMENT ON COLUMN profiles.identity_verified_at IS 'Timestamp when identity was verified via Stripe Identity (IDT-03)';

-- ROLLBACK:
-- DROP TRIGGER IF EXISTS trg_prevent_direct_kyc_update ON profiles;
-- DROP FUNCTION IF EXISTS prevent_direct_kyc_update();
-- ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_phone_e164;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS phone_number;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS identity_verification_status;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS identity_verification_session_id;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS identity_verified_at;
-- DROP INDEX IF EXISTS idx_profiles_identity_verification_status;
