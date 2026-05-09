-- Migration 0274: superseded.
--
-- This migration was authored before main's 0270_restore_anchor_field_protections.sql
-- and 0271_restore_get_flag_again.sql landed (PR #559 + follow-ups).  Those
-- two migrations restored the comprehensive `protect_anchor_status_transition`
-- trigger and the `get_flag(text)` function with clean single signatures —
-- which is exactly what this migration was attempting to do.
--
-- Running this migration after 0270/0271 would undo their work (the
-- DROP FUNCTION + simpler trigger body would partially regress chain_data /
-- legal_hold / parent_anchor_id / version_number / description protections).
--
-- Kept as an empty placeholder so the renumbered file order is stable in
-- environments that already applied an earlier copy of it under the
-- original 0265 name.
--
-- ROLLBACK: not applicable.

SELECT 1 WHERE FALSE;
