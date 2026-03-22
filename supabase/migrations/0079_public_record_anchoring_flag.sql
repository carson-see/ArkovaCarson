-- Migration: 0079_public_record_anchoring_flag.sql
-- Description: Switchboard flag for public record batch anchoring
-- ROLLBACK: DELETE FROM switchboard_flags WHERE id = 'ENABLE_PUBLIC_RECORD_ANCHORING';

INSERT INTO switchboard_flags (flag_key, enabled, description) VALUES
  ('ENABLE_PUBLIC_RECORD_ANCHORING', false, 'Enable Merkle batch anchoring of public records to Bitcoin');
