-- SCRUM-1095: Add revoked_by column to track who revoked
-- ROLLBACK: ALTER TABLE anchors DROP COLUMN IF EXISTS revoked_by;

ALTER TABLE anchors
  ADD COLUMN IF NOT EXISTS revoked_by uuid REFERENCES auth.users(id);

COMMENT ON COLUMN anchors.revoked_by IS
  'User who revoked this anchor claim. Worker-only write via service_role.';

NOTIFY pgrst, 'reload schema';
