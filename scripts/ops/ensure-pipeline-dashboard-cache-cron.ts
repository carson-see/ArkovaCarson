import { pathToFileURL } from 'node:url';

export const PIPELINE_DASHBOARD_CACHE_JOB_NAME = 'refresh-pipeline-dashboard-cache';
export const PIPELINE_DASHBOARD_CACHE_SCHEDULE = '* * * * *';
export const PIPELINE_DASHBOARD_CACHE_COMMAND =
  "SET statement_timeout = '20s'; SELECT refresh_pipeline_dashboard_cache();";
export const PIPELINE_DASHBOARD_SUPPORT_INDEX_NAME = 'idx_anchors_pipeline_status';
export const PIPELINE_DASHBOARD_SUPPORT_INDEX_SQL = `
CREATE INDEX CONCURRENTLY ${PIPELINE_DASHBOARD_SUPPORT_INDEX_NAME}
ON public.anchors (status, created_at DESC)
INCLUDE (chain_tx_id)
WHERE deleted_at IS NULL AND metadata ? 'pipeline_source';
`.trim();
export const PIPELINE_DASHBOARD_SUPPORT_INDEX_REBUILD_JOB_PREFIX =
  'scrum1708-rebuild-pipeline-status-index';
export const PIPELINE_DASHBOARD_FAST_STATS_FUNCTION_COMMENT =
  'SCRUM-1708 fast cache refresh: avoids idx_anchors_pipeline_status dependency while the production support index is invalid.';

export function buildPipelineDashboardCacheCronStatusSql(): string {
  return `
WITH jobs AS (
  SELECT COALESCE(jsonb_agg(to_jsonb(j) ORDER BY j.jobid), '[]'::jsonb) AS rows
  FROM (
    SELECT jobid, jobname, schedule, active, command
    FROM cron.job
    WHERE jobname = '${PIPELINE_DASHBOARD_CACHE_JOB_NAME}'
  ) j
),
cache AS (
  SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.cache_key), '[]'::jsonb) AS rows
  FROM (
    SELECT cache_key, updated_at
    FROM pipeline_dashboard_cache
    WHERE cache_key IN (
      'pipeline_stats',
      'by_source',
      'anchor_status_counts',
      'anchor_type_counts',
      'anchor_tx_stats',
      'record_types'
    )
  ) c
),
support_indexes AS (
  SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.indexname), '[]'::jsonb) AS rows
  FROM (
    SELECT
      c.relname AS indexname,
      c.reltuples::bigint AS reltuples,
      c.relpages,
      idx.indisvalid,
      idx.indisready,
      idx.indislive,
      pg_get_expr(idx.indpred, idx.indrelid) AS predicate,
      pg_get_indexdef(idx.indexrelid) AS indexdef
    FROM pg_index idx
    JOIN pg_class c ON c.oid = idx.indexrelid
    WHERE c.relname = '${PIPELINE_DASHBOARD_SUPPORT_INDEX_NAME}'
  ) i
),
index_progress AS (
  SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.pid), '[]'::jsonb) AS rows
  FROM (
    SELECT
      pid,
      phase,
      blocks_done,
      blocks_total,
      tuples_done,
      tuples_total
    FROM pg_stat_progress_create_index
    WHERE index_relid::regclass::text = '${PIPELINE_DASHBOARD_SUPPORT_INDEX_NAME}'
  ) p
),
stats_function AS (
  SELECT to_jsonb(f) AS row
  FROM (
    SELECT
      p.proconfig,
      md5(pg_get_functiondef(p.oid)) AS function_md5,
      d.description AS comment
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    LEFT JOIN pg_description d ON d.objoid = p.oid AND d.objsubid = 0
    WHERE n.nspname = 'public'
      AND p.proname = 'refresh_cache_pipeline_stats'
    LIMIT 1
  ) f
),
latest_job_runs AS (
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.start_time DESC), '[]'::jsonb) AS rows
  FROM (
    SELECT
      runid,
      jobid,
      job_pid,
      database,
      username,
      status,
      return_message,
      start_time,
      end_time
    FROM cron.job_run_details
    WHERE jobid IN (
      SELECT jobid
      FROM cron.job
      WHERE jobname = '${PIPELINE_DASHBOARD_CACHE_JOB_NAME}'
    )
    ORDER BY start_time DESC
    LIMIT 5
  ) r
),
support_index_job_runs AS (
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.start_time DESC), '[]'::jsonb) AS rows
  FROM (
    SELECT
      runid,
      jobid,
      status,
      return_message,
      start_time,
      end_time
    FROM cron.job_run_details
    WHERE jobid IN (
      SELECT jobid
      FROM cron.job
      WHERE jobname LIKE '${PIPELINE_DASHBOARD_SUPPORT_INDEX_REBUILD_JOB_PREFIX}%'
    )
    ORDER BY start_time DESC
    LIMIT 5
  ) r
)
SELECT
  now() AS checked_at,
  jobs.rows AS cron_jobs,
  cache.rows AS cache_rows,
  support_indexes.rows AS support_indexes,
  index_progress.rows AS index_progress,
  stats_function.row AS stats_function,
  latest_job_runs.rows AS latest_job_runs,
  support_index_job_runs.rows AS support_index_job_runs
FROM jobs, cache, support_indexes, index_progress, stats_function, latest_job_runs, support_index_job_runs;
`.trim();
}

export function buildEnsurePipelineDashboardCacheCronSql(): string {
  return `
DO $ensure_pipeline_dashboard_cache_cron$
DECLARE
  v_job record;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index idx
    JOIN pg_class c ON c.oid = idx.indexrelid
    WHERE c.relname = '${PIPELINE_DASHBOARD_SUPPORT_INDEX_NAME}'
      AND idx.indisvalid
      AND idx.indisready
      AND idx.indislive
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_description d ON d.objoid = p.oid AND d.objsubid = 0
    WHERE n.nspname = 'public'
      AND p.proname = 'refresh_cache_pipeline_stats'
      AND d.description = '${PIPELINE_DASHBOARD_FAST_STATS_FUNCTION_COMMENT}'
  ) THEN
    RAISE EXCEPTION '${PIPELINE_DASHBOARD_SUPPORT_INDEX_NAME} is missing or invalid and the SCRUM-1708 fast stats function is not installed; run --rebuild-support-index or --install-fast-stats-function before scheduling ${PIPELINE_DASHBOARD_CACHE_JOB_NAME}';
  END IF;

  FOR v_job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname = '${PIPELINE_DASHBOARD_CACHE_JOB_NAME}'
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;

  PERFORM cron.schedule(
    '${PIPELINE_DASHBOARD_CACHE_JOB_NAME}',
    '${PIPELINE_DASHBOARD_CACHE_SCHEDULE}',
    $cron$${PIPELINE_DASHBOARD_CACHE_COMMAND}$cron$
  );
END
$ensure_pipeline_dashboard_cache_cron$;

SELECT jobid, jobname, schedule, active, command
FROM cron.job
WHERE jobname = '${PIPELINE_DASHBOARD_CACHE_JOB_NAME}'
ORDER BY jobid;
`.trim();
}

export function buildInstallFastPipelineStatsFunctionSql(): string {
  return `
CREATE OR REPLACE FUNCTION public.refresh_cache_pipeline_stats()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '20s'
AS $function$
DECLARE
  v_total_records bigint := 0;
  v_unlinked_records bigint := -1;
  v_linked_records bigint := -1;
  v_embedded_records bigint := 0;
  v_total_anchors bigint := 0;
  v_pending_anchor bigint := -1;
  v_broadcasting_anchor bigint := -1;
  v_submitted_anchor bigint := -1;
  v_revoked_anchor bigint := -1;
  v_secured_anchor bigint := -1;
  v_bitcoin_anchored bigint := -1;
  v_pending_bitcoin bigint := -1;
BEGIN
  SELECT GREATEST(COALESCE(c.reltuples, 0)::bigint, 0)
  INTO v_total_records
  FROM pg_class c
  WHERE c.oid = 'public.public_records'::regclass;

  SELECT GREATEST(COALESCE(c.reltuples, 0)::bigint, 0)
  INTO v_embedded_records
  FROM pg_class c
  WHERE c.oid = 'public.public_record_embeddings'::regclass;

  SELECT GREATEST(COALESCE(c.reltuples, 0)::bigint, 0)
  INTO v_total_anchors
  FROM pg_class c
  WHERE c.oid = 'public.anchors'::regclass;

  BEGIN
    SELECT count(*) INTO v_unlinked_records
    FROM public.public_records
    WHERE anchor_id IS NULL;
  EXCEPTION
    WHEN query_canceled THEN v_unlinked_records := -1;
    WHEN OTHERS THEN v_unlinked_records := -1;
  END;

  IF v_unlinked_records >= 0 THEN
    v_linked_records := GREATEST(v_total_records - v_unlinked_records, 0);
  END IF;

  BEGIN
    SELECT count(*) INTO v_pending_anchor
    FROM public.anchors
    WHERE status = 'PENDING'
      AND deleted_at IS NULL;
  EXCEPTION
    WHEN query_canceled THEN v_pending_anchor := -1;
    WHEN OTHERS THEN v_pending_anchor := -1;
  END;

  BEGIN
    SELECT count(*) INTO v_broadcasting_anchor
    FROM public.anchors
    WHERE status = 'BROADCASTING'
      AND deleted_at IS NULL;
  EXCEPTION
    WHEN query_canceled THEN v_broadcasting_anchor := -1;
    WHEN OTHERS THEN v_broadcasting_anchor := -1;
  END;

  BEGIN
    SELECT count(*) INTO v_submitted_anchor
    FROM public.anchors
    WHERE status = 'SUBMITTED'
      AND deleted_at IS NULL;
  EXCEPTION
    WHEN query_canceled THEN v_submitted_anchor := -1;
    WHEN OTHERS THEN v_submitted_anchor := -1;
  END;

  BEGIN
    SELECT count(*) INTO v_revoked_anchor
    FROM public.anchors
    WHERE status = 'REVOKED'
      AND deleted_at IS NULL;
  EXCEPTION
    WHEN query_canceled THEN v_revoked_anchor := -1;
    WHEN OTHERS THEN v_revoked_anchor := -1;
  END;

  IF v_pending_anchor >= 0
    AND v_broadcasting_anchor >= 0
    AND v_submitted_anchor >= 0
    AND v_revoked_anchor >= 0
  THEN
    v_secured_anchor := GREATEST(
      v_total_anchors - v_pending_anchor - v_broadcasting_anchor - v_submitted_anchor - v_revoked_anchor,
      0
    );
  END IF;

  IF v_submitted_anchor >= 0 AND v_secured_anchor >= 0 THEN
    v_bitcoin_anchored := v_submitted_anchor + v_secured_anchor;
  END IF;

  IF v_unlinked_records >= 0 AND v_pending_anchor >= 0 AND v_broadcasting_anchor >= 0 THEN
    v_pending_bitcoin := v_unlinked_records + v_pending_anchor + v_broadcasting_anchor;
  END IF;

  INSERT INTO public.pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('pipeline_stats', jsonb_build_object(
    'total_records', v_total_records,
    'anchor_linked_records', v_linked_records,
    'pending_record_links', v_unlinked_records,
    'bitcoin_anchored_records', v_bitcoin_anchored,
    'pending_bitcoin_records', v_pending_bitcoin,
    'pending_anchor_records', v_pending_anchor,
    'broadcasting_records', v_broadcasting_anchor,
    'submitted_records', v_submitted_anchor,
    'secured_records', v_secured_anchor,
    'embedded_records', v_embedded_records,
    'source', 'scrum_1708_fast_stats'
  ), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value,
        updated_at = EXCLUDED.updated_at;
END;
$function$;

COMMENT ON FUNCTION public.refresh_cache_pipeline_stats() IS
  '${PIPELINE_DASHBOARD_FAST_STATS_FUNCTION_COMMENT}';

REVOKE ALL ON FUNCTION public.refresh_cache_pipeline_stats() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_cache_pipeline_stats() FROM anon;
REVOKE ALL ON FUNCTION public.refresh_cache_pipeline_stats() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_cache_pipeline_stats() TO service_role;
`.trim();
}

export function buildDropPipelineDashboardSupportIndexSql(): string {
  return `
DROP INDEX CONCURRENTLY IF EXISTS public.${PIPELINE_DASHBOARD_SUPPORT_INDEX_NAME};
`.trim();
}

export function buildCreatePipelineDashboardSupportIndexSql(): string {
  return PIPELINE_DASHBOARD_SUPPORT_INDEX_SQL;
}

export function buildEnableSupportIndexRebuildTimeoutBypassSql(): string {
  return `
ALTER ROLE postgres IN DATABASE postgres SET statement_timeout = 0;
`.trim();
}

export function buildResetSupportIndexRebuildTimeoutBypassSql(): string {
  return `
ALTER ROLE postgres IN DATABASE postgres RESET statement_timeout;
`.trim();
}

export function buildCleanupPipelineDashboardSupportIndexJobsSql(): string {
  return `
DO $cleanup_pipeline_dashboard_support_index_jobs$
DECLARE
  v_job record;
BEGIN
  FOR v_job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname LIKE '${PIPELINE_DASHBOARD_SUPPORT_INDEX_REBUILD_JOB_PREFIX}%'
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;
END
$cleanup_pipeline_dashboard_support_index_jobs$;
`.trim();
}

export interface OneTimeCronSchedule {
  jobName: string;
  schedule: string;
  scheduledForUtc: string;
}

export function buildOneTimeSupportIndexRebuildSchedule(now = new Date()): OneTimeCronSchedule {
  const scheduledFor = new Date(now.getTime() + 120_000);
  scheduledFor.setUTCSeconds(0, 0);
  const yyyy = scheduledFor.getUTCFullYear();
  const month = scheduledFor.getUTCMonth() + 1;
  const day = scheduledFor.getUTCDate();
  const hour = scheduledFor.getUTCHours();
  const minute = scheduledFor.getUTCMinutes();
  const pad = (value: number) => value.toString().padStart(2, '0');

  return {
    jobName: `${PIPELINE_DASHBOARD_SUPPORT_INDEX_REBUILD_JOB_PREFIX}-${yyyy}${pad(month)}${pad(day)}${pad(hour)}${pad(minute)}`,
    schedule: `${minute} ${hour} ${day} ${month} *`,
    scheduledForUtc: scheduledFor.toISOString(),
  };
}

export function buildSchedulePipelineDashboardSupportIndexSql(schedule: OneTimeCronSchedule): string {
  return `
SELECT cron.schedule(
  '${schedule.jobName}',
  '${schedule.schedule}',
  $cron$${PIPELINE_DASHBOARD_SUPPORT_INDEX_SQL}$cron$
) AS jobid;
`.trim();
}

export function buildRollbackPipelineDashboardCacheCronSql(): string {
  return `
DO $rollback_pipeline_dashboard_cache_cron$
DECLARE
  v_job record;
BEGIN
  FOR v_job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname = '${PIPELINE_DASHBOARD_CACHE_JOB_NAME}'
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;
END
$rollback_pipeline_dashboard_cache_cron$;

SELECT jobid, jobname, schedule, active, command
FROM cron.job
WHERE jobname = '${PIPELINE_DASHBOARD_CACHE_JOB_NAME}'
ORDER BY jobid;
`.trim();
}

interface CliOptions {
  projectRef: string;
  accessToken: string;
  mode:
    | 'status'
    | 'apply'
    | 'rollback'
    | 'rebuild-support-index'
    | 'install-fast-stats-function'
    | 'cleanup-support-index-rebuild-jobs';
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): CliOptions {
  const args = new Set(argv);
  const projectRef = env.SUPABASE_PROJECT_REF ?? '';
  const accessToken = env.SUPABASE_ACCESS_TOKEN ?? '';
  const mode = args.has('--apply')
    ? 'apply'
      : args.has('--rollback')
        ? 'rollback'
        : args.has('--rebuild-support-index')
          ? 'rebuild-support-index'
          : args.has('--install-fast-stats-function')
            ? 'install-fast-stats-function'
            : args.has('--cleanup-support-index-rebuild-jobs')
              ? 'cleanup-support-index-rebuild-jobs'
              : 'status';

  if (!projectRef) {
    throw new Error('SUPABASE_PROJECT_REF is required');
  }
  if (!accessToken) {
    throw new Error('SUPABASE_ACCESS_TOKEN is required');
  }

  return { projectRef, accessToken, mode };
}

async function executeSql(options: CliOptions, query: string, readOnly = false): Promise<unknown> {
  const endpointPath = readOnly ? 'query/read-only' : 'query';
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${options.projectRef}/database/${endpointPath}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Supabase query failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function runQuery(options: CliOptions): Promise<unknown> {
  if (options.mode === 'rebuild-support-index') {
    const cleanup = await executeSql(options, buildCleanupPipelineDashboardSupportIndexJobsSql());
    const timeoutBypass = await executeSql(options, buildEnableSupportIndexRebuildTimeoutBypassSql());
    const dropped = await executeSql(options, buildDropPipelineDashboardSupportIndexSql());
    const schedule = buildOneTimeSupportIndexRebuildSchedule();
    const scheduled = await executeSql(options, buildSchedulePipelineDashboardSupportIndexSql(schedule));
    const status = await executeSql(options, buildPipelineDashboardCacheCronStatusSql(), true);
    return { cleanup, timeoutBypass, dropped, schedule, scheduled, status };
  }

  if (options.mode === 'cleanup-support-index-rebuild-jobs') {
    const cleanup = await executeSql(options, buildCleanupPipelineDashboardSupportIndexJobsSql());
    const timeoutBypassReset = await executeSql(options, buildResetSupportIndexRebuildTimeoutBypassSql());
    const status = await executeSql(options, buildPipelineDashboardCacheCronStatusSql(), true);
    return { cleanup, timeoutBypassReset, status };
  }

  if (options.mode === 'install-fast-stats-function') {
    const installed = await executeSql(options, buildInstallFastPipelineStatsFunctionSql());
    const status = await executeSql(options, buildPipelineDashboardCacheCronStatusSql(), true);
    return { installed, status };
  }

  const query =
    options.mode === 'apply'
      ? buildEnsurePipelineDashboardCacheCronSql()
      : options.mode === 'rollback'
        ? buildRollbackPipelineDashboardCacheCronSql()
        : buildPipelineDashboardCacheCronStatusSql();
  return executeSql(options, query, options.mode === 'status');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2), process.env);
  const payload = await runQuery(options);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
