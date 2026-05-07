-- ROLLBACK: DROP TRIGGER IF EXISTS bq_export_watermarks_updated_at ON public.bq_export_watermarks; DROP FUNCTION IF EXISTS public.bq_export_watermarks_set_updated_at(); DROP TABLE IF EXISTS public.bq_export_watermarks CASCADE; NOTIFY pgrst, 'reload schema';
--
-- SCRUM-1721 — Watermark tracker for BigQuery export jobs (parent: SCRUM-1062 GCP-MAX-02).
--
-- Purpose:
--   Enables incremental sync of anchors/verifications/audit_events into the
--   `arkova_analytics` BigQuery dataset without re-reading the full source
--   table on every cron tick. Snapshot tables (organizations, api_keys) use
--   this to record last-completed snapshot date for idempotency.
--
-- Access:
--   service_role only. Worker (Cloud Run arkova-worker) writes via service_role
--   client; no browser path. authenticated and anon are denied SELECT/INSERT/
--   UPDATE/DELETE via FORCE-RLS deny-all policies (CLAUDE.md §1.4).

CREATE TABLE IF NOT EXISTS public.bq_export_watermarks (
  table_name      text PRIMARY KEY,
  last_synced_at  timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z'::timestamptz,
  last_synced_id  uuid,
  last_run_status text NOT NULL DEFAULT 'pending'
    CHECK (last_run_status IN ('pending', 'running', 'success', 'failed')),
  last_run_error  text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.bq_export_watermarks IS
  'BigQuery export job watermarks (SCRUM-1062). One row per mirrored table; tracks the last-synced source row + run status to enable incremental loads. service_role only — never browser-readable.';

ALTER TABLE public.bq_export_watermarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bq_export_watermarks FORCE ROW LEVEL SECURITY;

-- Deny-all policies for authenticated + anon. service_role has BYPASSRLS so
-- it still reads/writes; these policies keep the browser-side fully blocked.
CREATE POLICY bq_export_watermarks_no_select ON public.bq_export_watermarks
  FOR SELECT TO authenticated, anon USING (false);
CREATE POLICY bq_export_watermarks_no_insert ON public.bq_export_watermarks
  FOR INSERT TO authenticated, anon WITH CHECK (false);
CREATE POLICY bq_export_watermarks_no_update ON public.bq_export_watermarks
  FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY bq_export_watermarks_no_delete ON public.bq_export_watermarks
  FOR DELETE TO authenticated, anon USING (false);

-- Auto-bump updated_at on every UPDATE so observability of "stuck" sync runs
-- doesn't depend on the worker remembering to set it.
CREATE OR REPLACE FUNCTION public.bq_export_watermarks_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER bq_export_watermarks_updated_at
  BEFORE UPDATE ON public.bq_export_watermarks
  FOR EACH ROW
  EXECUTE FUNCTION public.bq_export_watermarks_set_updated_at();

-- Seed rows for the 5 mirrored tables. Initial last_synced_at = epoch so the
-- one-shot backfill (SCRUM-1727) starts from "everything since project
-- inception"; the 5-min incremental cron (SCRUM-1723) advances from there.
INSERT INTO public.bq_export_watermarks (table_name, last_synced_at, last_run_status)
VALUES
  ('anchors',       '1970-01-01T00:00:00Z'::timestamptz, 'pending'),
  ('verifications', '1970-01-01T00:00:00Z'::timestamptz, 'pending'),
  ('audit_events',  '1970-01-01T00:00:00Z'::timestamptz, 'pending'),
  ('organizations', '1970-01-01T00:00:00Z'::timestamptz, 'pending'),
  ('api_keys',      '1970-01-01T00:00:00Z'::timestamptz, 'pending')
ON CONFLICT (table_name) DO NOTHING;

NOTIFY pgrst, 'reload schema';
