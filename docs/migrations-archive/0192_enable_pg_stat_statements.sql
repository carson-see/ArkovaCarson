-- Migration 0192: Enable pg_stat_statements for query monitoring (PERF-05)
--
-- pg_stat_statements tracks execution statistics for all SQL statements.
-- This lets us identify slow queries, measure p95 latency, and track
-- query call counts for optimization.
--
-- Supabase projects have the extension pre-installed but it must be
-- explicitly enabled per-project.

CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Create a convenience view for the top 20 slowest queries
-- (accessible to authenticated dashboard users via service_role)
CREATE OR REPLACE VIEW public.v_slow_queries AS
SELECT
  queryid,
  LEFT(query, 200) AS query_preview,
  calls,
  ROUND((total_exec_time / 1000)::numeric, 2) AS total_time_sec,
  ROUND((mean_exec_time)::numeric, 2) AS mean_time_ms,
  ROUND((max_exec_time)::numeric, 2) AS max_time_ms,
  ROUND((stddev_exec_time)::numeric, 2) AS stddev_ms,
  rows
FROM pg_stat_statements
WHERE calls > 10
ORDER BY mean_exec_time DESC
LIMIT 50;

COMMENT ON VIEW v_slow_queries IS 'PERF-05: Top 50 slowest queries by mean execution time. Requires pg_stat_statements extension.';

-- Grant read access to the view via service_role only (admin dashboard)
-- Regular users cannot query this view due to RLS on the schema
REVOKE ALL ON v_slow_queries FROM anon, authenticated;
GRANT SELECT ON v_slow_queries TO service_role;

-- =============================================================================
-- ROLLBACK:
-- DROP VIEW IF EXISTS v_slow_queries;
-- DROP EXTENSION IF EXISTS pg_stat_statements;
-- =============================================================================
