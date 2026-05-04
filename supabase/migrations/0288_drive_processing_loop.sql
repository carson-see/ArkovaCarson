-- =============================================================================
-- Migration 0287: Drive folder-watch processing loop state
-- Story: SCRUM-1650 GD-AUTO-01 — Drive folder-watch processing loop
-- Covers PRD 3 ACs GD-02..07 (Operational Launch Readiness PRD Packet 2026-05-01)
-- Date: 2026-05-04
--
-- PURPOSE
-- -------
-- The Drive webhook handler (services/worker/src/api/v1/webhooks/drive.ts) is
-- explicitly a STUB today: it acknowledges Drive's headers-only push but
-- enqueues a canonical event with empty parent_ids. The launch promise — that
-- changed files in a watched folder land in the org queue — requires three
-- pieces of durable state that don't exist yet:
--
--   1. A per-integration changes.list page token. Drive's changes API is a
--      stream — the worker advances a token on each consumption pass, and
--      Drive guarantees we won't miss a change as long as we hand it the most
--      recent token. Without persistence, a worker restart loses position.
--
--   2. A revision-level dedupe ledger keyed (integration, file_id,
--      revision_id). Drive can deliver the same revision multiple times
--      (retries, channel-token churn, page-token reset, etc.). The existing
--      `drive_webhook_nonces` table from migration 0263 dedupes at the
--      delivery layer (channel_id, message_number) but a different message
--      number can carry the same revision — see GD-07 in the PRD.
--
--   3. A renewal-failure counter so the watch-renewal monitor (SCRUM-1147)
--      can alert after N consecutive failures (GD-02 in the PRD adds the
--      explicit alert obligation).
--
-- This migration adds those primitives. The worker code that consumes them
-- ships in SCRUM-1660 [Implement] alongside this file (TDD: red baseline +
-- handler change + tests in the same PR).
--
-- ROLLBACK
-- --------
--   DROP TABLE IF EXISTS drive_revision_ledger;
--   ALTER TABLE org_integrations
--     DROP COLUMN IF EXISTS last_page_token,
--     DROP COLUMN IF EXISTS last_token_advanced_at,
--     DROP COLUMN IF EXISTS watch_renewal_failure_count;
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- =============================================================================
-- 1. org_integrations: changes.list cursor + renewal-failure counter
-- =============================================================================
-- These columns are Drive-specific in their semantics but are added to the
-- shared `org_integrations` table because (a) the table already carries
-- subscription_id/subscription_expires_at/last_renewal_at/last_renewal_error
-- as a vendor-agnostic block (see migration 0251), and (b) the existing
-- watch-renewal monitor already iterates over rows with provider='google_drive'
-- — keeping the new columns adjacent avoids a JOIN per renewal pass.

ALTER TABLE org_integrations
  ADD COLUMN IF NOT EXISTS last_page_token text,
  ADD COLUMN IF NOT EXISTS last_token_advanced_at timestamptz,
  ADD COLUMN IF NOT EXISTS watch_renewal_failure_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN org_integrations.last_page_token IS
  'SCRUM-1650 GD-03: Drive changes.list page token. Advanced on every successful processing pass; resumed on worker restart so we never miss a change. Null until the first page-token bootstrap (changes.getStartPageToken). Currently Drive-specific; other providers leave null.';

COMMENT ON COLUMN org_integrations.last_token_advanced_at IS
  'SCRUM-1650 GD-03: timestamp of the last page-token advance. Lets the operator see when Drive last yielded a new token vs. when the integration silently drifted.';

COMMENT ON COLUMN org_integrations.watch_renewal_failure_count IS
  'SCRUM-1650 GD-02: consecutive watch-renewal failures. Reset to 0 on success. The renewal monitor emits drive.watch.renewal_failed when this hits 3, marks the integration health as degraded, and pages the operator.';

-- =============================================================================
-- 2. drive_revision_ledger: per-revision dedupe (GD-07)
-- =============================================================================

CREATE TABLE IF NOT EXISTS drive_revision_ledger (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id  uuid NOT NULL REFERENCES org_integrations(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  file_id         text NOT NULL,
  revision_id     text NOT NULL,
  -- Subset of file metadata the processor needed at decision time. Stored so
  -- a later replay / audit can answer "which folder was this in when we
  -- observed this revision?" without a follow-up files.get round-trip.
  parent_ids      text[],
  modified_time   timestamptz,
  actor_email     text,
  -- Why this revision did or didn't produce a queue item. Helps debugging
  -- (e.g. parent_mismatch tells the operator the watched folder didn't
  -- match this revision's parents).
  outcome         text NOT NULL CHECK (outcome IN (
    'queued',
    'parent_mismatch',
    'unrelated_change'
  )),
  rule_event_id   uuid,
  processed_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (integration_id, file_id, revision_id)
);

CREATE INDEX IF NOT EXISTS idx_drive_revision_ledger_integration_processed
  ON drive_revision_ledger (integration_id, processed_at DESC);
CREATE INDEX IF NOT EXISTS idx_drive_revision_ledger_org_processed
  ON drive_revision_ledger (org_id, processed_at DESC);

ALTER TABLE drive_revision_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_revision_ledger FORCE ROW LEVEL SECURITY;

-- service_role: full access (worker writes here on every change processed)
DROP POLICY IF EXISTS drive_revision_ledger_service ON drive_revision_ledger;
CREATE POLICY drive_revision_ledger_service ON drive_revision_ledger
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- authenticated: org members can read their org's rows for support / audit.
-- The `parent_ids` and `actor_email` are useful diagnostic context that an
-- org admin should be able to see without needing engineering to look in
-- prod logs.
DROP POLICY IF EXISTS drive_revision_ledger_org_select ON drive_revision_ledger;
CREATE POLICY drive_revision_ledger_org_select ON drive_revision_ledger
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.user_id = (SELECT auth.uid())
        AND om.org_id = drive_revision_ledger.org_id
    )
  );

GRANT ALL ON drive_revision_ledger TO service_role;
GRANT SELECT ON drive_revision_ledger TO authenticated;

COMMENT ON TABLE drive_revision_ledger IS
  'SCRUM-1650 GD-07: revision-level dedupe + audit log for Drive changes.list processing. Unique on (integration_id, file_id, revision_id). Sweep entries older than 90 days (separate retention job).';

-- =============================================================================
-- 3. PostgREST schema cache reload
-- =============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
