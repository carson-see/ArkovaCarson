-- Migration 0227: ARK-101 — Add PENDING_RESOLUTION to anchor_status enum
--
-- PURPOSE
-- -------
-- An anchor in PENDING_RESOLUTION state is waiting for an org admin to pick
-- the terminal version among multiple rapid webhook updates for the same
-- external_file_id. This is the "collision queue" from the Hakichain
-- response. See ARK-101 / INT-11 for the full behavior.
--
-- Split from the RPC migration (0226) per the ALTER TYPE ADD VALUE
-- transaction constraint (same reason 0223 is split from 0224).
--
-- JIRA: SCRUM-1011 (ARK-101 / INT-11)
-- EPIC: SCRUM-1010 (CIBA)
--
-- ROLLBACK:
--   One-way. See 0223 for the enum-rollback pattern if ever needed.

ALTER TYPE anchor_status ADD VALUE IF NOT EXISTS 'PENDING_RESOLUTION';

NOTIFY pgrst, 'reload schema';
