-- Migration 0244: SCALE-02 anchor index cleanup
--
-- Purpose:
--   Remove clearly redundant indexes from public.anchors after the core
--   anti-bloat changes have already landed. Kept separate so lock contention
--   on the hot anchors table cannot block the more important function/storage
--   fixes.
--
-- Rollback:
--   Recreate the indexes if query plans regress.

SET lock_timeout = '5s';

DROP INDEX IF EXISTS public.idx_anchors_public_id;
DROP INDEX IF EXISTS public.idx_anchors_pending_status;

RESET lock_timeout;
