-- SCRUM-4514 follow-up: persist the platform operator's resolution rationale.
-- Rollback: ALTER TABLE public.webhook_dlq DROP COLUMN resolved_request_id, DROP COLUMN resolved_by, DROP COLUMN resolved_note;

ALTER TABLE public.webhook_dlq
  ADD COLUMN resolved_note text,
  ADD COLUMN resolved_by uuid,
  ADD COLUMN resolved_request_id uuid;

ALTER TABLE public.webhook_dlq
  ADD CONSTRAINT webhook_dlq_resolved_note_length
  CHECK (resolved_note IS NULL OR (char_length(resolved_note) BETWEEN 1 AND 500));

COMMENT ON COLUMN public.webhook_dlq.resolved_note IS
  'Bounded operator rationale recorded when an inbound webhook failure is acknowledged after partner redelivery.';
COMMENT ON COLUMN public.webhook_dlq.resolved_by IS
  'Authenticated platform-admin user id that acknowledged the inbound webhook failure.';
COMMENT ON COLUMN public.webhook_dlq.resolved_request_id IS
  'Per-request marker used to read back winners of the atomic unresolved-row claim.';
