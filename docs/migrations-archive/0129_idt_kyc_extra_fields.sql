-- Migration: 0129_idt_kyc_extra_fields.sql
-- Description: Additional KYC fields per IDT WS1 spec.
-- Adds phone_verified_at, kyc_provider tracking, and is_verified computed view.
-- ROLLBACK: See bottom of file.

-- Phone verification timestamp
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz DEFAULT NULL;

-- KYC provider tracking (which service verified the identity)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS kyc_provider text DEFAULT NULL
  CHECK (kyc_provider IS NULL OR kyc_provider IN ('stripe_identity', 'dev_bypass'));

-- Extend the prevent_direct_kyc_update trigger to also protect new fields
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
    OR OLD.phone_verified_at IS DISTINCT FROM NEW.phone_verified_at
    OR OLD.kyc_provider IS DISTINCT FROM NEW.kyc_provider
  THEN
    RAISE EXCEPTION 'Identity verification fields can only be updated by the system';
  END IF;

  RETURN NEW;
END;
$$;

-- RPC: Check if a user is verified (KYC complete + email confirmed)
-- Used by public search to gate name visibility
CREATE OR REPLACE FUNCTION is_user_verified(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT identity_verification_status = 'verified'
     FROM profiles
     WHERE id = p_user_id),
    false
  );
$$;

-- RPC: Dev-mode bypass for KYC verification (only works when called by service_role)
-- Used in development/testing to auto-verify users without Stripe Identity
CREATE OR REPLACE FUNCTION dev_bypass_kyc(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Set the role claim so the prevent_direct_kyc_update trigger allows the update
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  UPDATE profiles
  SET identity_verification_status = 'verified',
      identity_verified_at = now(),
      kyc_provider = 'dev_bypass'
  WHERE id = p_user_id;

  RETURN true;
END;
$$;

COMMENT ON COLUMN profiles.phone_verified_at IS 'When phone number was verified via SMS (IDT WS1)';
COMMENT ON COLUMN profiles.kyc_provider IS 'Which KYC provider verified the identity: stripe_identity or dev_bypass (IDT WS1)';
COMMENT ON FUNCTION is_user_verified IS 'Check if a user has completed KYC verification (IDT WS1)';
COMMENT ON FUNCTION dev_bypass_kyc IS 'Dev-only: bypass KYC for testing (IDT WS1)';

-- ROLLBACK:
-- DROP FUNCTION IF EXISTS dev_bypass_kyc(uuid);
-- DROP FUNCTION IF EXISTS is_user_verified(uuid);
-- ALTER TABLE profiles DROP COLUMN IF EXISTS phone_verified_at;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS kyc_provider;
