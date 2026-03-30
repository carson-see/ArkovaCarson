-- Compensating migration for deleted 0122_idt_kyc_identity_fields.sql
-- (duplicate PK with 0122_audit_events_target_id_text.sql)
-- IDT Phase D: Identity verification fields for KYC via Stripe Identity (IDT-03)
-- All statements are idempotent for production safety.
--
-- ROLLBACK:
-- DROP TRIGGER IF EXISTS trg_prevent_direct_kyc_update ON profiles;
-- DROP FUNCTION IF EXISTS prevent_direct_kyc_update();
-- ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_phone_e164;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS phone_number;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS identity_verification_status;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS identity_verification_session_id;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS identity_verified_at;

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone_number text DEFAULT NULL;

-- Use DO block for CHECK constraint idempotency
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles'
    AND column_name = 'identity_verification_status'
  ) THEN
    ALTER TABLE profiles
      ADD COLUMN identity_verification_status text DEFAULT 'unstarted'
        CHECK (identity_verification_status IN ('unstarted', 'pending', 'verified', 'requires_input', 'canceled'));
  END IF;
END $$;

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS identity_verification_session_id text DEFAULT NULL;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS identity_verified_at timestamptz DEFAULT NULL;

-- Phone number E.164 format constraint (idempotent via DO block)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_phone_e164'
  ) THEN
    ALTER TABLE profiles ADD CONSTRAINT profiles_phone_e164 CHECK (
      phone_number IS NULL OR phone_number ~ '^\+[1-9]\d{1,14}$'
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_profiles_identity_verification_status
  ON profiles (identity_verification_status)
  WHERE identity_verification_status != 'unstarted';

-- Trigger to prevent direct KYC updates (CREATE OR REPLACE is idempotent)
CREATE OR REPLACE FUNCTION prevent_direct_kyc_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF OLD.identity_verification_status IS DISTINCT FROM NEW.identity_verification_status
    OR OLD.identity_verification_session_id IS DISTINCT FROM NEW.identity_verification_session_id
    OR OLD.identity_verified_at IS DISTINCT FROM NEW.identity_verified_at
  THEN
    RAISE EXCEPTION 'Identity verification fields can only be updated by the system';
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger (idempotent via DO block)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_prevent_direct_kyc_update'
  ) THEN
    CREATE TRIGGER trg_prevent_direct_kyc_update
      BEFORE UPDATE ON profiles
      FOR EACH ROW
      EXECUTE FUNCTION prevent_direct_kyc_update();
  END IF;
END $$;
