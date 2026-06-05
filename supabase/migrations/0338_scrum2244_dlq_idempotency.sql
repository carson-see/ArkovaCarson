BEGIN;

-- SCRUM-2244: make webhook dead-letter-queue writes idempotent so the same
-- event DLQ'd twice (retry / re-emit during a DB outage) does NOT create
-- duplicate audit rows. The baseline `webhook_dead_letter_queue` table only
-- had a PK on `id`, so two inserts of the same (endpoint_id, event_type,
-- event_id) produced two rows — undermining audit integrity (SOC2).
--
-- Two failure modes legitimately produce SEPARATE rows for the same event and
-- must therefore be part of the dedup key:
--   * 'http_delivery' — endpoint exhausted all retries (HTTP/network failure).
--   * 'log_write'      — the webhook_delivery_logs audit-row write itself
--                        failed persistently (DB outage), routed here so the
--                        event isn't silently dropped (SCRUM-2244 HARDEN-1-A).
-- A `failure_kind` discriminator column distinguishes them; the partial unique
-- index keys on (endpoint_id, event_type, event_id, failure_kind).
--
-- The index is PARTIAL on `resolved = false`: once an operator resolves/
-- dismisses a DLQ row, a genuinely new recurrence of the same failure mode is
-- allowed to create a fresh unresolved row (the resolved history is preserved,
-- not overwritten). Active/unresolved duplicates are what we collapse.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS public.uq_webhook_dlq_event_failure_kind_active;
--   ALTER TABLE public.webhook_dead_letter_queue DROP COLUMN IF EXISTS failure_kind;

-- Discriminator column. Default 'http_delivery' backfills every pre-existing
-- row correctly: before this PR the DLQ only ever held HTTP-delivery failures.
ALTER TABLE public.webhook_dead_letter_queue
  ADD COLUMN IF NOT EXISTS failure_kind text NOT NULL DEFAULT 'http_delivery'
    CHECK (failure_kind IN ('http_delivery', 'log_write'));

-- Partial unique index for idempotent re-DLQ of active (unresolved) failures.
-- The worker upserts with onConflict on these columns + ignoreDuplicates.
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_dlq_event_failure_kind_active
  ON public.webhook_dead_letter_queue (endpoint_id, event_type, event_id, failure_kind)
  WHERE resolved = false;

COMMIT;
