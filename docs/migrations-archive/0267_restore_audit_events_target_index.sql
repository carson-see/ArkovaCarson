-- Migration 0267: Restore idx_audit_events_target dropped in migration 0214.
--
-- 0214 dropped this index based on "rarely queried directly" — that
-- assumption is wrong now: SCRUM-896 (GET /api/v1/anchor/{publicId}/lifecycle)
-- makes (target_type='anchor', target_id=<uuid>) a public query path
-- (anonymous + API key). Without the compound index audit_events scans
-- linearly per anchor and the SCRUM-895/896 p95 latency budget regresses.
--
-- Recreated identically to migration 0006 (compound index + partial WHERE).
-- IF NOT EXISTS keeps this idempotent against any environment that may
-- still carry the original.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS public.idx_audit_events_target;

CREATE INDEX IF NOT EXISTS idx_audit_events_target
  ON public.audit_events (target_type, target_id)
  WHERE target_id IS NOT NULL;

COMMENT ON INDEX public.idx_audit_events_target IS
  'SCRUM-896: required by GET /api/v1/anchor/{publicId}/lifecycle. Restored after migration 0214 dropped it.';
