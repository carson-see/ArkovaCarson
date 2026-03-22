-- Migration: 0079_public_record_anchoring_flag.sql
-- Description: Switchboard flag for public record batch anchoring
-- ROLLBACK: DELETE FROM switchboard_flags WHERE id = 'ENABLE_PUBLIC_RECORD_ANCHORING';

INSERT INTO switchboard_flags (id, value, default_value, description, is_dangerous) VALUES
  ('ENABLE_PUBLIC_RECORD_ANCHORING', false, false, 'Enable Merkle batch anchoring of public records to Bitcoin', false);
