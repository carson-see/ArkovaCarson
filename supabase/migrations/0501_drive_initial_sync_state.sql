-- DRIVE-BACKFILL (founder directive 2026-09-29): per-(org, Drive folder)
-- initial-sync bookkeeping.
-- Tier: T3 (new table + RLS + FORCE; migration-class change).
--
-- WHAT
-- ----
-- `drive_initial_sync_state` — one row per (org_id, folder_id), tracking
-- whether the backfill that enumerates a watched Drive folder's PRE-EXISTING
-- files has ever run, is currently running, or failed terminally. This is
-- what makes the initial sync both OBSERVABLE (an admin/ops query can see
-- which folders have been backfilled and how many files were seen/enqueued)
-- and RESUMABLE (`page_token` + `files_synced_count` let a capped run
-- continue from exactly where it stopped, across job invocations).
--
-- WHY NOT AN EXISTING TABLE
-- -------------------------
-- `drive_watch_state` (migration 0351, DRIVE-02/06) looks adjacent — also
-- per-(org, integration, folder) — but it is a different, fully-built,
-- currently-uncalled Drive push-channel bootstrap/renewal system (see
-- `services/worker/src/integrations/connectors/agents.md`'s "two parallel
-- Drive watch-tracking systems" note). Its `status` CHECK constraint
-- (active/permission_denied/expired/stopped/degraded/failed) is channel-
-- lifecycle vocabulary, not sync-progress vocabulary, and it carries no
-- pagination cursor or file-count columns at all. Repurposing it would
-- conflate two systems the existing docs explicitly warn against conflating,
-- for a schema that does not fit the need. `folders` (0365/0462) has no
-- generic JSONB column to piggyback on either. A small, purpose-built table
-- is the honest fix.
--
-- SECURITY (§1.4)
-- ---------------
-- RLS ENABLED + FORCE ROW LEVEL SECURITY. This is operational/observability
-- state the worker (service_role) reads and writes; no browser surface reads
-- it directly today, so the canonical restrictive deny-all policy
-- (`mfa_verified_authenticated`, same identity as migration 0499) is correct
-- here — anon/authenticated get nothing, service_role (RLS-exempt) is the
-- only reader/writer. No PII: folder id is an opaque Drive string, `org_id`/
-- `integration_id` are FKs, `last_error` is bounded and non-secret (mirrors
-- `drive_watch_state.last_renewal_error`).
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS public.drive_initial_sync_state;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.drive_initial_sync_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- The connection this sync ran under MOST RECENTLY. Mutable: a reconnect
  -- (new integration row) that re-triggers an already-synced folder does not
  -- change this row's identity — the row is keyed by (org_id, folder_id), not
  -- by integration, because "has this folder ever been fully synced" is an
  -- org-level fact, independent of which live connection currently backs it.
  integration_id uuid NOT NULL REFERENCES public.org_integrations(id) ON DELETE CASCADE,
  -- Drive folder id (opaque string, not a UUID) — matches
  -- organization_rules.trigger_config.drive_folders[].folder_id.
  folder_id text NOT NULL,
  -- The rule that most recently triggered this sync, for audit
  -- cross-reference only. Nullable: a folder can be named by more than one
  -- rule over time, and a reconnect-triggered sync may not have a single
  -- owning rule in hand.
  rule_id uuid REFERENCES public.organization_rules(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'in_progress',
  -- Drive files.list nextPageToken to resume enumeration from. NULL means
  -- either "not started yet" or "no continuation pending" (status disambiguates).
  page_token text,
  files_seen_count integer NOT NULL DEFAULT 0 CHECK (files_seen_count >= 0),
  files_enqueued_count integer NOT NULL DEFAULT 0 CHECK (files_enqueued_count >= 0),
  -- Bounded, non-secret failure reason (e.g. 'drive_403', 'drive_404') —
  -- never a raw Drive error body. Mirrors drive_watch_state.last_renewal_error.
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drive_initial_sync_state_status_check
    CHECK (status IN ('in_progress', 'completed', 'failed')),
  CONSTRAINT drive_initial_sync_state_org_folder_unique
    UNIQUE (org_id, folder_id)
);

COMMENT ON TABLE public.drive_initial_sync_state IS
  'Per-(org, Drive folder) initial-sync bookkeeping (DRIVE-BACKFILL, founder '
  'directive 2026-09-29): observability + resumability for the backfill that '
  'enumerates a watched folder''s pre-existing files. Service-role only — '
  'deny-all by design, see mfa_verified_authenticated policy below.';

CREATE INDEX IF NOT EXISTS idx_drive_initial_sync_state_org
  ON public.drive_initial_sync_state (org_id);
CREATE INDEX IF NOT EXISTS idx_drive_initial_sync_state_integration
  ON public.drive_initial_sync_state (integration_id);

DROP TRIGGER IF EXISTS trg_drive_initial_sync_state_updated_at ON public.drive_initial_sync_state;
CREATE TRIGGER trg_drive_initial_sync_state_updated_at
  BEFORE UPDATE ON public.drive_initial_sync_state
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

ALTER TABLE public.drive_initial_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drive_initial_sync_state FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.drive_initial_sync_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.drive_initial_sync_state TO service_role;

CREATE POLICY mfa_verified_authenticated
  ON public.drive_initial_sync_state
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

COMMENT ON POLICY mfa_verified_authenticated
  ON public.drive_initial_sync_state IS
  'Deny-all by design. Service-only initial-sync bookkeeping: anon and '
  'authenticated may never read or mutate rows; only the worker (service_role) '
  'reads and writes this table.';

NOTIFY pgrst, 'reload schema';
COMMIT;
