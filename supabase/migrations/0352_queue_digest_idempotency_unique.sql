BEGIN;

-- =============================================================================
-- 0352 — Atomic idempotency reservation for the daily queue-review digest
--        (QUEUE-07, SCRUM-2353; review finding F3 on PR #1365)
--
-- WHY THIS EXISTS (the concurrent double-send race):
--   deliverDigestToAdmin() was: read the QUEUE_DIGEST_SENT marker → send the
--   email → write the marker. Two overlapping /queue-digest invocations
--   (Cloud Scheduler retry, or a manual run overlapping the scheduled one) can
--   BOTH observe no marker, BOTH send, and only THEN both write — duplicate
--   admin emails. audit_events had no uniqueness on the digest key and the cron
--   took no advisory lock.
--
--   This makes the QUEUE_DIGEST_SENT marker UNIQUE per (org, recipient,
--   digest_date). The worker now RESERVES by inserting the marker BEFORE
--   sending: the unique index lets exactly one concurrent worker win the insert;
--   the loser's insert conflicts (23505) and it skips the send. On a send
--   failure the winner releases (deletes) the reservation so the day's retry can
--   re-reserve — no duplicate, no permanently-stuck marker on a transient send
--   failure.
--
-- NOTES:
--   * `details` is a TEXT column holding a JSON string, so the digest_date is
--     extracted via the IMMUTABLE `(details::jsonb) ->> 'digest_date'` cast
--     (indexable). The cast is only ever evaluated for QUEUE_DIGEST_SENT rows
--     (partial WHERE), which recordDelivery/reserveDelivery always write as valid
--     JSON.
--   * QUEUE_DIGEST is behind ENABLE_QUEUE_DIGEST (default OFF, not yet in prod),
--     so there are no pre-existing QUEUE_DIGEST_SENT rows for the UNIQUE build to
--     collide with.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_queue_digest_sent_once
  ON public.audit_events (org_id, target_id, ((details::jsonb) ->> 'digest_date'))
  WHERE event_type = 'QUEUE_DIGEST_SENT';

COMMENT ON INDEX public.uq_queue_digest_sent_once IS
  'F3/SCRUM-2353: one QUEUE_DIGEST_SENT marker per (org, recipient, digest_date) — '
  'backs the reserve-before-send atomic idempotency for the daily queue digest.';

COMMIT;

-- ROLLBACK:
-- BEGIN;
-- DROP INDEX IF EXISTS public.uq_queue_digest_sent_once;
-- COMMIT;
