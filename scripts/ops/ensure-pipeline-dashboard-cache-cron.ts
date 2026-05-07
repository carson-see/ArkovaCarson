import { pathToFileURL } from 'node:url';

export const PIPELINE_DASHBOARD_CACHE_JOB_NAME = 'refresh-pipeline-dashboard-cache';
export const PIPELINE_DASHBOARD_CACHE_SCHEDULE = '*/2 * * * *';
export const PIPELINE_DASHBOARD_CACHE_COMMAND =
  "SET statement_timeout = '120s'; SELECT refresh_pipeline_dashboard_cache();";
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
  'SCRUM-1708 pipeline-only fast cache refresh using idx_anchors_pipeline_status.';
export const PIPELINE_DASHBOARD_REFRESH_FUNCTION_COMMENT =
  'SCRUM-1708 non-overlapping dashboard cache refresh wrapper.';

/** Builds a read-only evidence query for cron, cache, support-index, and stats-function state. */
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
  SELECT COALESCE(
    (
      SELECT to_jsonb(f)
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
    jsonb_build_object('proconfig', NULL, 'function_md5', NULL, 'comment', NULL)
  ) AS row
),
refresh_function AS (
  SELECT COALESCE(
    (
      SELECT to_jsonb(f)
      FROM (
        SELECT
          p.proconfig,
          md5(pg_get_functiondef(p.oid)) AS function_md5,
          d.description AS comment
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        LEFT JOIN pg_description d ON d.objoid = p.oid AND d.objsubid = 0
        WHERE n.nspname = 'public'
          AND p.proname = 'refresh_pipeline_dashboard_cache'
        LIMIT 1
      ) f
    ),
    jsonb_build_object('proconfig', NULL, 'function_md5', NULL, 'comment', NULL)
  ) AS row
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
  refresh_function.row AS refresh_function,
  latest_job_runs.rows AS latest_job_runs,
  support_index_job_runs.rows AS support_index_job_runs
FROM jobs, cache, support_indexes, index_progress, stats_function, refresh_function, latest_job_runs, support_index_job_runs;
`.trim();
}

/** Builds the idempotent pg_cron apply script for the dashboard cache refresh job. */
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
  ) THEN
    RAISE EXCEPTION '${PIPELINE_DASHBOARD_SUPPORT_INDEX_NAME} is missing or invalid; run --rebuild-support-index before scheduling ${PIPELINE_DASHBOARD_CACHE_JOB_NAME}';
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

/** Builds the production-scale cache writers used once the support index is valid. */
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
  v_anchor_id_null_frac float := 0;
  v_unlinked_records bigint := -1;
  v_linked_records bigint := -1;
  v_embedded_records bigint := 0;
  v_pending_anchor bigint := -1;
  v_broadcasting_anchor bigint := -1;
  v_submitted_anchor bigint := -1;
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

  SELECT COALESCE(s.null_frac, 0)
  INTO v_anchor_id_null_frac
  FROM pg_stats s
  WHERE s.schemaname = 'public'
    AND s.tablename = 'public_records'
    AND s.attname = 'anchor_id';

  v_anchor_id_null_frac := COALESCE(v_anchor_id_null_frac, 0);
  v_unlinked_records := GREATEST(round(v_total_records * v_anchor_id_null_frac)::bigint, 0);

  IF v_unlinked_records >= 0 THEN
    v_linked_records := GREATEST(v_total_records - v_unlinked_records, 0);
  END IF;

  BEGIN
    SELECT count(*) INTO v_pending_anchor
    FROM public.anchors
    WHERE status = 'PENDING'
      AND deleted_at IS NULL
      AND metadata ? 'pipeline_source';
  EXCEPTION
    WHEN query_canceled THEN v_pending_anchor := -1;
    WHEN OTHERS THEN v_pending_anchor := -1;
  END;

  BEGIN
    SELECT count(*) INTO v_broadcasting_anchor
    FROM public.anchors
    WHERE status = 'BROADCASTING'
      AND deleted_at IS NULL
      AND metadata ? 'pipeline_source';
  EXCEPTION
    WHEN query_canceled THEN v_broadcasting_anchor := -1;
    WHEN OTHERS THEN v_broadcasting_anchor := -1;
  END;

  BEGIN
    SELECT count(*) INTO v_submitted_anchor
    FROM public.anchors
    WHERE status = 'SUBMITTED'
      AND deleted_at IS NULL
      AND metadata ? 'pipeline_source'
      AND chain_tx_id IS NOT NULL;
  EXCEPTION
    WHEN query_canceled THEN v_submitted_anchor := -1;
    WHEN OTHERS THEN v_submitted_anchor := -1;
  END;

  BEGIN
    SELECT count(*) INTO v_secured_anchor
    FROM public.anchors
    WHERE status = 'SECURED'
      AND deleted_at IS NULL
      AND metadata ? 'pipeline_source'
      AND chain_tx_id IS NOT NULL;
  EXCEPTION
    WHEN query_canceled THEN v_secured_anchor := -1;
    WHEN OTHERS THEN v_secured_anchor := -1;
  END;

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
    'pending_record_links_approximate', true,
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

CREATE OR REPLACE FUNCTION public.refresh_cache_anchor_status_counts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '10s'
AS $function$
DECLARE
  v_total bigint := 0;
  v_values text[] := ARRAY[]::text[];
  v_freqs text[] := ARRAY[]::text[];
  v_result jsonb := '{}'::jsonb;
  v_count bigint;
  v_sum bigint := 0;
  i int;
BEGIN
  SELECT GREATEST(COALESCE(c.reltuples, 0)::bigint, 0)
  INTO v_total
  FROM pg_class c
  WHERE c.oid = 'public.anchors'::regclass;

  SELECT
    regexp_split_to_array(trim(both '{}' from s.most_common_vals::text), ','),
    regexp_split_to_array(trim(both '{}' from s.most_common_freqs::text), ',')
  INTO v_values, v_freqs
  FROM pg_stats s
  WHERE s.schemaname = 'public'
    AND s.tablename = 'anchors'
    AND s.attname = 'status';

  FOR i IN 1..COALESCE(array_length(v_values, 1), 0) LOOP
    v_count := GREATEST(round(v_total * COALESCE(v_freqs[i]::numeric, 0))::bigint, 0);
    v_sum := v_sum + v_count;
    v_result := v_result || jsonb_build_object(v_values[i], v_count);
  END LOOP;

  IF NOT (v_result ? 'PENDING') THEN v_result := v_result || jsonb_build_object('PENDING', 0); END IF;
  IF NOT (v_result ? 'SUBMITTED') THEN v_result := v_result || jsonb_build_object('SUBMITTED', 0); END IF;
  IF NOT (v_result ? 'BROADCASTING') THEN v_result := v_result || jsonb_build_object('BROADCASTING', 0); END IF;
  IF NOT (v_result ? 'SECURED') THEN v_result := v_result || jsonb_build_object('SECURED', 0); END IF;
  IF NOT (v_result ? 'REVOKED') THEN v_result := v_result || jsonb_build_object('REVOKED', GREATEST(v_total - v_sum, 0)); END IF;

  v_result := v_result
    || jsonb_build_object('total', v_total)
    || jsonb_build_object('approximate', true, 'source', 'pg_stats');

  INSERT INTO public.pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('anchor_status_counts', v_result, now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value,
        updated_at = EXCLUDED.updated_at;
END;
$function$;

COMMENT ON FUNCTION public.refresh_cache_anchor_status_counts() IS
  'SCRUM-1708 bounded cache writer: broad anchor status distribution from pg_stats.';

REVOKE ALL ON FUNCTION public.refresh_cache_anchor_status_counts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_cache_anchor_status_counts() FROM anon;
REVOKE ALL ON FUNCTION public.refresh_cache_anchor_status_counts() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_cache_anchor_status_counts() TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_cache_by_source()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '10s'
AS $function$
DECLARE
  v_total bigint := 0;
  v_values text[] := ARRAY[]::text[];
  v_freqs text[] := ARRAY[]::text[];
  v_result jsonb := '{}'::jsonb;
  v_count bigint;
  v_sum bigint := 0;
  i int;
BEGIN
  SELECT GREATEST(COALESCE(c.reltuples, 0)::bigint, 0)
  INTO v_total
  FROM pg_class c
  WHERE c.oid = 'public.public_records'::regclass;

  SELECT
    regexp_split_to_array(trim(both '{}' from s.most_common_vals::text), ','),
    regexp_split_to_array(trim(both '{}' from s.most_common_freqs::text), ',')
  INTO v_values, v_freqs
  FROM pg_stats s
  WHERE s.schemaname = 'public'
    AND s.tablename = 'public_records'
    AND s.attname = 'source';

  FOR i IN 1..COALESCE(array_length(v_values, 1), 0) LOOP
    v_count := GREATEST(round(v_total * COALESCE(v_freqs[i]::numeric, 0))::bigint, 0);
    v_sum := v_sum + v_count;
    v_result := v_result || jsonb_build_object(v_values[i], v_count);
  END LOOP;

  IF v_total > v_sum THEN
    v_result := v_result || jsonb_build_object('OTHER', v_total - v_sum);
  END IF;

  INSERT INTO public.pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('by_source', v_result, now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value,
        updated_at = EXCLUDED.updated_at;
END;
$function$;

COMMENT ON FUNCTION public.refresh_cache_by_source() IS
  'SCRUM-1708 bounded cache writer: public_records source distribution from pg_stats.';

REVOKE ALL ON FUNCTION public.refresh_cache_by_source() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_cache_by_source() FROM anon;
REVOKE ALL ON FUNCTION public.refresh_cache_by_source() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_cache_by_source() TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_cache_anchor_type_counts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '10s'
AS $function$
DECLARE
  v_total bigint := 0;
  v_type_values text[] := ARRAY[]::text[];
  v_type_freqs text[] := ARRAY[]::text[];
  v_status_values text[] := ARRAY[]::text[];
  v_status_freqs text[] := ARRAY[]::text[];
  v_result jsonb := '[]'::jsonb;
  v_count bigint;
  i int;
  j int;
BEGIN
  SELECT GREATEST(COALESCE(c.reltuples, 0)::bigint, 0)
  INTO v_total
  FROM pg_class c
  WHERE c.oid = 'public.anchors'::regclass;

  SELECT
    regexp_split_to_array(trim(both '{}' from s.most_common_vals::text), ','),
    regexp_split_to_array(trim(both '{}' from s.most_common_freqs::text), ',')
  INTO v_type_values, v_type_freqs
  FROM pg_stats s
  WHERE s.schemaname = 'public'
    AND s.tablename = 'anchors'
    AND s.attname = 'credential_type';

  SELECT
    regexp_split_to_array(trim(both '{}' from s.most_common_vals::text), ','),
    regexp_split_to_array(trim(both '{}' from s.most_common_freqs::text), ',')
  INTO v_status_values, v_status_freqs
  FROM pg_stats s
  WHERE s.schemaname = 'public'
    AND s.tablename = 'anchors'
    AND s.attname = 'status';

  FOR i IN 1..COALESCE(array_length(v_type_values, 1), 0) LOOP
    FOR j IN 1..COALESCE(array_length(v_status_values, 1), 0) LOOP
      v_count := GREATEST(
        round(
          v_total
          * COALESCE(v_type_freqs[i]::numeric, 0)
          * COALESCE(v_status_freqs[j]::numeric, 0)
        )::bigint,
        0
      );
      v_result := v_result || jsonb_build_array(jsonb_build_object(
        'credential_type', v_type_values[i],
        'status', v_status_values[j],
        'count', v_count,
        'approximate', true
      ));
    END LOOP;
  END LOOP;

  INSERT INTO public.pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('anchor_type_counts', v_result, now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value,
        updated_at = EXCLUDED.updated_at;
END;
$function$;

COMMENT ON FUNCTION public.refresh_cache_anchor_type_counts() IS
  'SCRUM-1708 bounded cache writer: credential/status distribution from pg_stats.';

REVOKE ALL ON FUNCTION public.refresh_cache_anchor_type_counts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_cache_anchor_type_counts() FROM anon;
REVOKE ALL ON FUNCTION public.refresh_cache_anchor_type_counts() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_cache_anchor_type_counts() TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_cache_record_types()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '10s'
AS $function$
DECLARE
  v_values text[] := ARRAY[]::text[];
  v_result jsonb := '[]'::jsonb;
  i int;
BEGIN
  SELECT regexp_split_to_array(trim(both '{}' from s.most_common_vals::text), ',')
  INTO v_values
  FROM pg_stats s
  WHERE s.schemaname = 'public'
    AND s.tablename = 'public_records'
    AND s.attname = 'record_type';

  FOR i IN 1..COALESCE(array_length(v_values, 1), 0) LOOP
    v_result := v_result || to_jsonb(v_values[i]);
  END LOOP;

  INSERT INTO public.pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('record_types', v_result, now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value,
        updated_at = EXCLUDED.updated_at;
END;
$function$;

COMMENT ON FUNCTION public.refresh_cache_record_types() IS
  'SCRUM-1708 bounded cache writer: record type list from pg_stats.';

REVOKE ALL ON FUNCTION public.refresh_cache_record_types() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_cache_record_types() FROM anon;
REVOKE ALL ON FUNCTION public.refresh_cache_record_types() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_cache_record_types() TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_pipeline_dashboard_cache()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_started_at timestamptz := clock_timestamp();
  v_errors jsonb := '[]'::jsonb;
  v_succeeded int := 0;
  v_got_lock boolean;
BEGIN
  SELECT pg_try_advisory_xact_lock(8675309, 1) INTO v_got_lock;
  IF NOT v_got_lock THEN
    RETURN jsonb_build_object(
      'status', 'skipped',
      'reason', 'another refresh in progress',
      'duration_ms', (extract(epoch from clock_timestamp() - v_started_at) * 1000)::int
    );
  END IF;

  BEGIN PERFORM refresh_cache_pipeline_stats(); v_succeeded := v_succeeded + 1;
  EXCEPTION WHEN OTHERS THEN v_errors := v_errors || jsonb_build_object('pipeline_stats', SQLERRM); END;

  BEGIN PERFORM refresh_cache_anchor_status_counts(); v_succeeded := v_succeeded + 1;
  EXCEPTION WHEN OTHERS THEN v_errors := v_errors || jsonb_build_object('anchor_status_counts', SQLERRM); END;

  BEGIN PERFORM refresh_cache_by_source(); v_succeeded := v_succeeded + 1;
  EXCEPTION WHEN OTHERS THEN v_errors := v_errors || jsonb_build_object('by_source', SQLERRM); END;

  BEGIN PERFORM refresh_cache_anchor_type_counts(); v_succeeded := v_succeeded + 1;
  EXCEPTION WHEN OTHERS THEN v_errors := v_errors || jsonb_build_object('anchor_type_counts', SQLERRM); END;

  BEGIN PERFORM refresh_cache_record_types(); v_succeeded := v_succeeded + 1;
  EXCEPTION WHEN OTHERS THEN v_errors := v_errors || jsonb_build_object('record_types', SQLERRM); END;

  BEGIN PERFORM refresh_cache_anchor_tx_stats(); v_succeeded := v_succeeded + 1;
  EXCEPTION WHEN OTHERS THEN v_errors := v_errors || jsonb_build_object('anchor_tx_stats', SQLERRM); END;

  RETURN jsonb_build_object(
    'status', 'refreshed',
    'succeeded', v_succeeded,
    'errors', v_errors,
    'duration_ms', (extract(epoch from clock_timestamp() - v_started_at) * 1000)::int
  );
END;
$function$;

COMMENT ON FUNCTION public.refresh_pipeline_dashboard_cache() IS
  '${PIPELINE_DASHBOARD_REFRESH_FUNCTION_COMMENT}';

REVOKE ALL ON FUNCTION public.refresh_pipeline_dashboard_cache() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_pipeline_dashboard_cache() FROM anon;
REVOKE ALL ON FUNCTION public.refresh_pipeline_dashboard_cache() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_pipeline_dashboard_cache() TO service_role;
`.trim();
}

/** Builds the concurrent drop SQL for the optional support-index rebuild path. */
export function buildDropPipelineDashboardSupportIndexSql(): string {
  return `
DROP INDEX CONCURRENTLY IF EXISTS public.${PIPELINE_DASHBOARD_SUPPORT_INDEX_NAME};
`.trim();
}

/** Returns the concurrent create-index SQL for the optional support-index rebuild path. */
export function buildCreatePipelineDashboardSupportIndexSql(): string {
  return PIPELINE_DASHBOARD_SUPPORT_INDEX_SQL;
}

/** Builds the temporary timeout bypass required for long-running pg_cron index rebuilds. */
export function buildEnableSupportIndexRebuildTimeoutBypassSql(): string {
  return `
ALTER ROLE postgres IN DATABASE postgres SET statement_timeout = 0;
`.trim();
}

/** Builds the cleanup SQL that removes the temporary pg_cron timeout bypass. */
export function buildResetSupportIndexRebuildTimeoutBypassSql(): string {
  return `
ALTER ROLE postgres IN DATABASE postgres RESET statement_timeout;
`.trim();
}

/** Builds cleanup SQL for obsolete one-time support-index rebuild cron jobs. */
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

/** Builds a one-time pg_cron schedule two minutes in the future for the concurrent index rebuild. */
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

/** Builds the one-time pg_cron job that recreates the support index concurrently. */
export function buildSchedulePipelineDashboardSupportIndexSql(schedule: OneTimeCronSchedule): string {
  return `
SELECT cron.schedule(
  '${schedule.jobName}',
  '${schedule.schedule}',
  $cron$${PIPELINE_DASHBOARD_SUPPORT_INDEX_SQL}$cron$
) AS jobid;
`.trim();
}

/** Builds rollback SQL that unschedules only the dashboard cache refresh cron job. */
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

export type CliMode =
  | 'status'
  | 'apply'
  | 'rollback'
  | 'rebuild-support-index'
  | 'install-fast-stats-function'
  | 'cleanup-support-index-rebuild-jobs';

export interface CliOptions {
  projectRef: string;
  accessToken: string;
  mode: CliMode;
}

type SqlExecutor = (options: CliOptions, query: string, readOnly?: boolean) => Promise<unknown>;

const MODE_FLAG_TO_MODE: Readonly<Record<string, Exclude<CliMode, 'status'>>> = {
  '--apply': 'apply',
  '--rollback': 'rollback',
  '--rebuild-support-index': 'rebuild-support-index',
  '--install-fast-stats-function': 'install-fast-stats-function',
  '--cleanup-support-index-rebuild-jobs': 'cleanup-support-index-rebuild-jobs',
};

/** Parses env-backed CLI options and rejects ambiguous write-mode combinations. */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): CliOptions {
  const args = new Set(argv);
  const projectRef = env.SUPABASE_PROJECT_REF ?? '';
  const accessToken = env.SUPABASE_ACCESS_TOKEN ?? '';
  const selectedModes = Object.entries(MODE_FLAG_TO_MODE)
    .filter(([flag]) => args.has(flag))
    .map(([, mode]) => mode);

  if (selectedModes.length > 1) {
    throw new Error(`Choose exactly one mode flag, received: ${selectedModes.join(', ')}`);
  }

  if (!projectRef) {
    throw new Error('SUPABASE_PROJECT_REF is required');
  }
  if (!accessToken) {
    throw new Error('SUPABASE_ACCESS_TOKEN is required');
  }

  const mode = selectedModes[0] ?? 'status';
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

/** Executes the selected Supabase management operation. */
export async function runQuery(options: CliOptions, executor: SqlExecutor = executeSql): Promise<unknown> {
  if (options.mode === 'rebuild-support-index') {
    let rebuildScheduled = false;

    try {
      const cleanup = await executor(options, buildCleanupPipelineDashboardSupportIndexJobsSql());
      const timeoutBypass = await executor(options, buildEnableSupportIndexRebuildTimeoutBypassSql());
      const dropped = await executor(options, buildDropPipelineDashboardSupportIndexSql());
      const schedule = buildOneTimeSupportIndexRebuildSchedule();
      const scheduled = await executor(options, buildSchedulePipelineDashboardSupportIndexSql(schedule));
      rebuildScheduled = true;
      const status = await executor(options, buildPipelineDashboardCacheCronStatusSql(), true);
      return { cleanup, timeoutBypass, dropped, schedule, scheduled, status };
    } catch (error) {
      if (!rebuildScheduled) {
        await executor(options, buildResetSupportIndexRebuildTimeoutBypassSql()).catch(() => undefined);
      }
      throw error;
    }
  }

  if (options.mode === 'cleanup-support-index-rebuild-jobs') {
    const cleanup = await executor(options, buildCleanupPipelineDashboardSupportIndexJobsSql());
    const timeoutBypassReset = await executor(options, buildResetSupportIndexRebuildTimeoutBypassSql());
    const status = await executor(options, buildPipelineDashboardCacheCronStatusSql(), true);
    return { cleanup, timeoutBypassReset, status };
  }

  if (options.mode === 'install-fast-stats-function') {
    const installed = await executor(options, buildInstallFastPipelineStatsFunctionSql());
    const status = await executor(options, buildPipelineDashboardCacheCronStatusSql(), true);
    return { installed, status };
  }

  let query = buildPipelineDashboardCacheCronStatusSql();
  if (options.mode === 'apply') {
    query = buildEnsurePipelineDashboardCacheCronSql();
  } else if (options.mode === 'rollback') {
    query = buildRollbackPipelineDashboardCacheCronSql();
  }

  return executor(options, query, options.mode === 'status');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2), process.env);
  const payload = await runQuery(options);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
