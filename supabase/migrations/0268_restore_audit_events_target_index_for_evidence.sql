-- Migration 0268: Restore idx_audit_events_target dropped in migration 0214 —
-- needed by SCRUM-1173 GET /api/v1/anchor/{publicId}/evidence (and the same
-- index PR #570's migration 0267 restores). IF NOT EXISTS makes this safe to
-- apply in either order; both migrations create the SAME named index, so
-- whichever lands first wins, and the second is a no-op.
--
-- 0214 dropped this index based on "rarely queried directly" — that
-- assumption is wrong now: SCRUM-896 + SCRUM-1173 both make
-- (target_type='anchor', target_id=<uuid>) a public query path. Without
-- the index, audit_events scans linearly per anchor and the partner
-- evidence/lifecycle endpoints regress under load.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS public.idx_audit_events_target;

CREATE INDEX IF NOT EXISTS idx_audit_events_target
  ON public.audit_events (target_type, target_id)
  WHERE target_id IS NOT NULL;

COMMENT ON INDEX public.idx_audit_events_target IS
  'SCRUM-896 / SCRUM-1173: required by GET /anchor/{publicId}/lifecycle and GET /anchor/{publicId}/evidence. Restored after migration 0214 dropped it. Idempotent across PRs #570 and #573.';
