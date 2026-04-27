-- Migration: 0278_db_health_monitor_rpcs.sql
-- Description: SCRUM-1307 (R0-8-FU1) — SECURITY DEFINER RPCs for db-health-monitor.
--   Closes the gap from SCRUM-1254 (R0-8) where fetchCronFailures() and
--   fetchDeadTuples() called RPCs that didn't exist; the monitor logged
--   warnings and emitted no alerts. Both RPCs are SECDEF + SET search_path
--   = public per CLAUDE.md §1.4. EXECUTE granted only to service_role.
-- Rollback:
--   DROP FUNCTION IF EXISTS public.get_recent_cron_failures(int);
--   DROP FUNCTION IF EXISTS public.get_table_bloat_stats(text[]);

-- ---- get_recent_cron_failures(since_minutes int) -------------------------
-- Returns failed pg_cron job runs in the last N minutes. Used by the worker
-- db-health-monitor to surface cron blow-ups (e.g. the SCRUM-1255 jobid 3
-- death spiral) into Sentry as alerts.
CREATE OR REPLACE FUNCTION public.get_recent_cron_failures(since_minutes int)
RETURNS TABLE (
  jobid           int,
  jobname         text,
  return_message  text,
  start_time      timestamptz,
  end_time        timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    jrd.jobid::int,
    j.jobname::text,
    jrd.return_message::text,
    jrd.start_time,
    jrd.end_time
  FROM cron.job_run_details jrd
  LEFT JOIN cron.job j ON j.jobid = jrd.jobid
  WHERE jrd.status = 'failed'
    AND jrd.end_time > now() - make_interval(mins => since_minutes)
  ORDER BY jrd.end_time DESC
  LIMIT 200;
$$;

REVOKE ALL ON FUNCTION public.get_recent_cron_failures(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_recent_cron_failures(int) TO service_role;

COMMENT ON FUNCTION public.get_recent_cron_failures(int) IS
  'SCRUM-1307 (R0-8-FU1): worker db-health-monitor reads recent pg_cron failures via this RPC. SECDEF + service_role-only.';

-- ---- get_table_bloat_stats(table_names text[]) --------------------------
-- Returns dead-tuple bloat + last-autovacuum timestamps for the named tables.
-- Used by db-health-monitor to alert when n_dead_tup / n_live_tup > 0.20 on
-- the hot anchors / public_records / audit_events paths (Forensic 4 class).
CREATE OR REPLACE FUNCTION public.get_table_bloat_stats(table_names text[])
RETURNS TABLE (
  schemaname        text,
  relname           text,
  n_live_tup        bigint,
  n_dead_tup        bigint,
  last_autovacuum   timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    s.schemaname::text,
    s.relname::text,
    s.n_live_tup,
    s.n_dead_tup,
    s.last_autovacuum
  FROM pg_stat_user_tables s
  WHERE s.schemaname = 'public'
    AND s.relname = ANY(table_names);
$$;

REVOKE ALL ON FUNCTION public.get_table_bloat_stats(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_table_bloat_stats(text[]) TO service_role;

COMMENT ON FUNCTION public.get_table_bloat_stats(text[]) IS
  'SCRUM-1307 (R0-8-FU1): worker db-health-monitor reads dead-tuple bloat + autovacuum recency for named tables. SECDEF + service_role-only.';
