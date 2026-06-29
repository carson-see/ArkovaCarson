BEGIN;

-- =============================================================================
-- 0348 — Releasable Stripe-webhook idempotency claim (SCRUM-2353)
--
-- WHY THIS EXISTS (the bug PR #1317's first fix could not solve):
--   The orphan-recovery fix needs to RELEASE an idempotency claim when a
--   post-claim side effect throws, so the Stripe retry can reprocess the event
--   exactly once. The original fix released the claim with
--   `DELETE FROM billing_events`, but `billing_events` is an APPEND-ONLY audit
--   table guarded by BEFORE DELETE/UPDATE triggers
--   (`reject_billing_events_delete` / `reject_billing_events_update` →
--    `reject_audit_modification`, which RAISEs ERRCODE 23514
--    "Audit events are immutable."). The DELETE therefore ALWAYS fails in prod;
--   the claim row persists; the retry hits the `stripe_event_id` UNIQUE
--   constraint and the side effect is dropped forever — the exact orphan bug.
--
-- THE FIX: separate the *releasable claim* from the *immutable audit*.
--   `public.webhook_event_claims` is a MUTABLE table whose sole job is the
--   pre-side-effect idempotency lock. It carries the same `stripe_event_id`
--   UNIQUE serialization that `billing_events` did (so concurrent duplicate
--   deliveries still resolve to exactly one winner) but has NO immutability
--   trigger, so a failed side effect can DELETE its own claim and free the
--   retry. The immutable `billing_events` audit row is written only on SUCCESS
--   and is never touched here — auditors keep their append-only trail.
--
-- SECURITY (§1.4):
--   - RLS enabled + FORCE ROW LEVEL SECURITY (defends even table owner).
--   - All privileges revoked from PUBLIC / anon / authenticated; only
--     service_role may SELECT / INSERT / DELETE. The worker runs as
--     service_role; no browser path ever reaches this table.
--   - No PII: only the opaque Stripe event id + a server timestamp are stored.
--   - DELIBERATELY no append-only trigger: this table MUST be deletable. That
--     is the whole point — it is an operational lock, not an audit record.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.webhook_event_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id text NOT NULL UNIQUE,
  claimed_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.webhook_event_claims IS
  'Releasable Stripe-webhook idempotency claims (SCRUM-2353). Inserted BEFORE a '
  'webhook side effect runs; the stripe_event_id UNIQUE constraint serializes '
  'concurrent duplicate deliveries to exactly one winner. On a thrown side '
  'effect the claim row is DELETEd so the Stripe retry reprocesses exactly '
  'once; on success it persists and the immutable billing_events audit row is '
  'written separately. MUTABLE BY DESIGN — must NOT carry an append-only '
  'immutability trigger (unlike billing_events).';

COMMENT ON COLUMN public.webhook_event_claims.stripe_event_id IS
  'Stripe Event id (evt_…). UNIQUE: the idempotency lock that prevents Stripe '
  'retries / sibling workers from re-running a side effect.';

-- ─── RLS: service-role only (§1.4) ───────────────────────────────────────────
ALTER TABLE public.webhook_event_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_event_claims FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.webhook_event_claims FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.webhook_event_claims TO service_role;

DROP POLICY IF EXISTS webhook_event_claims_service_all ON public.webhook_event_claims;
CREATE POLICY webhook_event_claims_service_all
  ON public.webhook_event_claims
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Reload PostgREST schema cache so the new table is visible to the API layer.
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ROLLBACK:
-- BEGIN;
-- DROP POLICY IF EXISTS webhook_event_claims_service_all ON public.webhook_event_claims;
-- DROP TABLE IF EXISTS public.webhook_event_claims;
-- NOTIFY pgrst, 'reload schema';
-- COMMIT;
