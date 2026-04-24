CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

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

REVOKE ALL ON v_slow_queries FROM anon, authenticated;
GRANT SELECT ON v_slow_queries TO service_role;;
