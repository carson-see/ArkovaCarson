-- Migration: 0005_role_immutability.sql
-- Description: Enforce role immutability at database level
-- Rollback: DROP TRIGGER IF EXISTS enforce_role_immutability ON profiles; DROP FUNCTION IF EXISTS check_role_immutability();

-- Function to enforce role immutability
-- Once a role is set (not NULL), it cannot be changed
CREATE OR REPLACE FUNCTION check_role_immutability()
RETURNS TRIGGER AS $$
BEGIN
  -- If old role was set (not NULL), prevent any change
  IF OLD.role IS NOT NULL AND (
    NEW.role IS NULL OR
    NEW.role != OLD.role
  ) THEN
    RAISE EXCEPTION 'Role cannot be changed once set. Current role: %', OLD.role
      USING ERRCODE = 'check_violation';
  END IF;

  -- If role is being set for the first time, record the timestamp
  IF OLD.role IS NULL AND NEW.role IS NOT NULL THEN
    NEW.role_set_at = now();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to enforce role immutability on UPDATE
CREATE TRIGGER enforce_role_immutability
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION check_role_immutability();

-- Comments
COMMENT ON FUNCTION check_role_immutability() IS 'Prevents role changes after initial assignment and sets role_set_at timestamp';
