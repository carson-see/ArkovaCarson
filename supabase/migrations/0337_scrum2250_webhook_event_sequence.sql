BEGIN;

-- SCRUM-2250 (BUG-2026-05-16-001, SEV1 integrity): replica-safe monotonic
-- ordering source for outbound webhook delivery.
--
-- The webhook delivery engine stamps a strictly-monotonic `sequence` into every
-- dispatched payload so consumers can detect/reject out-of-order delivery for
-- the SAME resource (a retried earlier event arriving after a later one). The
-- original implementation derived `sequence` from an in-process `Date.now()`
-- counter. The worker runs 2-10 Cloud Run replicas and same-resource lifecycle
-- events (anchor.submitted/secured/revoked) are emitted from DIFFERENT replicas,
-- so wall-clock skew between replicas could stamp a LATER event with a LOWER
-- sequence than an EARLIER one — the exact SEV1 corruption (consumer drops the
-- newer event as stale).
--
-- Fix: a single global Postgres SEQUENCE is the source of truth. nextval() is
-- atomic and globally monotonic across every replica and every connection, with
-- no clock dependency. The worker connects via PostgREST (service_role), not a
-- raw pg connection, so the sequence is exposed through a SECURITY DEFINER RPC
-- the worker calls with db.rpc('next_webhook_sequence'). One DB round-trip per
-- dispatch.

CREATE SEQUENCE IF NOT EXISTS public.webhook_event_sequence
  AS bigint
  START WITH 1
  INCREMENT BY 1
  NO CYCLE;

COMMENT ON SEQUENCE public.webhook_event_sequence IS
  'SCRUM-2250: globally-monotonic source for outbound webhook payload.sequence. '
  'Replica-safe (atomic nextval, no wall-clock dependency). Consumed via the '
  'next_webhook_sequence() RPC by the worker service_role. Only relative order '
  'within a resource_key is meaningful — absolute magnitude is not a contract.';

-- Lock down direct sequence access; the only sanctioned path is the RPC below.
REVOKE ALL ON SEQUENCE public.webhook_event_sequence FROM PUBLIC, anon, authenticated;
-- service_role retains USAGE so the SECURITY DEFINER owner (and any future
-- direct service-role use) can advance it.
GRANT USAGE ON SEQUENCE public.webhook_event_sequence TO service_role;

-- SECURITY DEFINER RPC the worker invokes via PostgREST. Returns the next
-- monotonic value. SET search_path = public per CLAUDE.md §1.4.
CREATE OR REPLACE FUNCTION public.next_webhook_sequence()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT nextval('public.webhook_event_sequence');
$$;

COMMENT ON FUNCTION public.next_webhook_sequence() IS
  'SCRUM-2250: returns the next globally-monotonic webhook event sequence value. '
  'Replica-safe ordering source for outbound webhook delivery. service_role only.';

REVOKE ALL ON FUNCTION public.next_webhook_sequence() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_webhook_sequence() TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ROLLBACK:
-- DROP FUNCTION IF EXISTS public.next_webhook_sequence();
-- DROP SEQUENCE IF EXISTS public.webhook_event_sequence;
-- NOTIFY pgrst, 'reload schema';
