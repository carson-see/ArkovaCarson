-- TLA-01: credential_type is immutable after anchor leaves PENDING status
-- The TLA+ model proves this invariant is necessary: once an anchor is
-- SUBMITTED or SECURED, changing credential_type would invalidate the
-- anchored fingerprint's metadata binding.

CREATE OR REPLACE FUNCTION prevent_credential_type_change()
RETURNS TRIGGER AS $$
BEGIN
  -- Only block changes when status is not PENDING
  IF OLD.status != 'PENDING' AND OLD.credential_type IS DISTINCT FROM NEW.credential_type THEN
    RAISE EXCEPTION 'credential_type cannot be changed after anchor status leaves PENDING (current: %)', OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = public;

CREATE TRIGGER trg_credential_type_immutable
  BEFORE UPDATE ON anchors
  FOR EACH ROW
  EXECUTE FUNCTION prevent_credential_type_change();

-- ROLLBACK:
-- DROP TRIGGER IF EXISTS trg_credential_type_immutable ON anchors;
-- DROP FUNCTION IF EXISTS prevent_credential_type_change();
