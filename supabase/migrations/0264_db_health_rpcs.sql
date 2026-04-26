-- SCRUM-1307: SECURITY DEFINER RPCs for db-health-monitor (SCRUM-1254).
--
-- PURPOSE
-- -------
-- The db-health-monitor job (services/worker/src/jobs/db-health-monitor.ts)
-- queries two system catalog views — cron.job_run_details and
-- pg_stat_user_tables — that are not accessible to PostgREST's
-- authenticated/anon roles. These SECURITY DEFINER RPCs wrap the queries
-- and are callable only by service_role, matching the worker's client.
--
-- 1. get_recent_cron_failures(since_minutes) — returns pg_cron failures
--    within the specified window so the monitor can page on job failures.
-- 2. get_table_bloat_stats(table_names) — returns dead-tuple / autovacuum
--    stats for the specified tables so the monitor can detect bloat.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS get_recent_cron_failures(int);
--   DROP FUNCTION IF EXISTS get_table_bloat_stats(text[]);

-- =============================================================================
-- 1. get_recent_cron_failures
-- =============================================================================

CREATE OR REPLACE FUNCTION get_recent_cron_failures(since_minutes int)
RETURNS TABLE(
  jobid int,
  jobname text,
  return_message text,
  start_time timestamptz,
  end_time timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    jrd.jobid::int,
    jrd.jobname::text,
    jrd.return_message::text,
    jrd.start_time,
    jrd.end_time
  FROM cron.job_run_details jrd
  WHERE jrd.status = 'failed'
    AND jrd.start_time >= now() - (since_minutes * interval '1 minute')
  ORDER BY jrd.start_time DESC;
$$;

REVOKE ALL ON FUNCTION get_recent_cron_failures(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_recent_cron_failures(int) TO service_role;

COMMENT ON FUNCTION get_recent_cron_failures(int) IS
  'SCRUM-1307: Returns pg_cron job failures within the last N minutes. Used by db-health-monitor (SCRUM-1254) to detect and page on cron failures.';

-- =============================================================================
-- 2. get_table_bloat_stats
-- =============================================================================

CREATE OR REPLACE FUNCTION get_table_bloat_stats(table_names text[])
RETURNS TABLE(
  schemaname text,
  relname text,
  n_live_tup bigint,
  n_dead_tup bigint,
  last_autovacuum timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    pst.schemaname::text,
    pst.relname::text,
    pst.n_live_tup,
    pst.n_dead_tup,
    pst.last_autovacuum
  FROM pg_stat_user_tables pst
  WHERE pst.schemaname = 'public'
    AND pst.relname = ANY(table_names)
  ORDER BY pst.n_dead_tup DESC;
$$;

REVOKE ALL ON FUNCTION get_table_bloat_stats(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_table_bloat_stats(text[]) TO service_role;

COMMENT ON FUNCTION get_table_bloat_stats(text[]) IS
  'SCRUM-1307: Returns dead-tuple and autovacuum stats for specified public tables. Used by db-health-monitor (SCRUM-1254) to detect bloat and stale autovacuum.';

-- =============================================================================
-- Reload PostgREST schema cache so RPCs are immediately callable.
-- =============================================================================

NOTIFY pgrst, 'reload schema';
