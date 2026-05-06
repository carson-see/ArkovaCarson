import { describe, expect, it } from 'vitest';
import {
  PIPELINE_DASHBOARD_CACHE_COMMAND,
  PIPELINE_DASHBOARD_CACHE_JOB_NAME,
  PIPELINE_DASHBOARD_CACHE_SCHEDULE,
  PIPELINE_DASHBOARD_FAST_STATS_FUNCTION_COMMENT,
  PIPELINE_DASHBOARD_SUPPORT_INDEX_NAME,
  PIPELINE_DASHBOARD_SUPPORT_INDEX_REBUILD_JOB_PREFIX,
  buildCleanupPipelineDashboardSupportIndexJobsSql,
  buildEnableSupportIndexRebuildTimeoutBypassSql,
  buildEnsurePipelineDashboardCacheCronSql,
  buildCreatePipelineDashboardSupportIndexSql,
  buildDropPipelineDashboardSupportIndexSql,
  buildInstallFastPipelineStatsFunctionSql,
  buildOneTimeSupportIndexRebuildSchedule,
  buildPipelineDashboardCacheCronStatusSql,
  buildResetSupportIndexRebuildTimeoutBypassSql,
  buildRollbackPipelineDashboardCacheCronSql,
  buildSchedulePipelineDashboardSupportIndexSql,
} from './ensure-pipeline-dashboard-cache-cron';

describe('pipeline dashboard cache cron SQL', () => {
  it('builds an idempotent apply script for exactly the pipeline cache job', () => {
    const sql = buildEnsurePipelineDashboardCacheCronSql();

    expect(sql).toContain(`WHERE jobname = '${PIPELINE_DASHBOARD_CACHE_JOB_NAME}'`);
    expect(sql).toContain(`PERFORM cron.schedule(\n    '${PIPELINE_DASHBOARD_CACHE_JOB_NAME}'`);
    expect(sql).toContain(`'${PIPELINE_DASHBOARD_CACHE_SCHEDULE}'`);
    expect(sql).toContain(PIPELINE_DASHBOARD_CACHE_COMMAND);
    expect(sql).toContain(PIPELINE_DASHBOARD_SUPPORT_INDEX_NAME);
    expect(sql).toContain('is missing or invalid');
    expect(sql).toContain(PIPELINE_DASHBOARD_FAST_STATS_FUNCTION_COMMENT);
    expect(sql).not.toContain('vacuum-anchors');
    expect(sql).not.toContain('batch-anchors');
  });

  it('uses the SET-prefixed command required by the cache refresh runbook', () => {
    expect(PIPELINE_DASHBOARD_CACHE_COMMAND).toBe(
      "SET statement_timeout = '50s'; SELECT refresh_pipeline_dashboard_cache();",
    );
  });

  it('builds a rollback script that only unschedules the pipeline cache job', () => {
    const sql = buildRollbackPipelineDashboardCacheCronSql();

    expect(sql).toContain(`WHERE jobname = '${PIPELINE_DASHBOARD_CACHE_JOB_NAME}'`);
    expect(sql).toContain('cron.unschedule(v_job.jobid)');
    expect(sql).not.toContain('cron.schedule');
    expect(sql).not.toContain('vacuum-anchors');
  });

  it('builds a read-only status query for cron and cache evidence', () => {
    const sql = buildPipelineDashboardCacheCronStatusSql();

    expect(sql).toContain(`WHERE jobname = '${PIPELINE_DASHBOARD_CACHE_JOB_NAME}'`);
    expect(sql).toContain('pipeline_dashboard_cache');
    expect(sql).toContain('pipeline_stats');
    expect(sql).toContain(PIPELINE_DASHBOARD_SUPPORT_INDEX_NAME);
    expect(sql).toContain('pg_stat_progress_create_index');
    expect(sql).toContain('cron.job_run_details');
    expect(sql).toContain('latest_job_runs');
    expect(sql).toContain('support_index_job_runs');
    expect(sql).toContain('stats_function');
  });

  it('builds concurrent support-index rebuild SQL for production repair', () => {
    const dropSql = buildDropPipelineDashboardSupportIndexSql();
    const createSql = buildCreatePipelineDashboardSupportIndexSql();
    const cleanupSql = buildCleanupPipelineDashboardSupportIndexJobsSql();
    const enableTimeoutBypassSql = buildEnableSupportIndexRebuildTimeoutBypassSql();
    const resetTimeoutBypassSql = buildResetSupportIndexRebuildTimeoutBypassSql();
    const schedule = buildOneTimeSupportIndexRebuildSchedule(new Date('2026-05-06T19:42:30.000Z'));
    const scheduleSql = buildSchedulePipelineDashboardSupportIndexSql(schedule);

    expect(dropSql).toBe(`DROP INDEX CONCURRENTLY IF EXISTS public.${PIPELINE_DASHBOARD_SUPPORT_INDEX_NAME};`);
    expect(createSql).toContain(`CREATE INDEX CONCURRENTLY ${PIPELINE_DASHBOARD_SUPPORT_INDEX_NAME}`);
    expect(createSql).toContain('ON public.anchors (status, created_at DESC)');
    expect(createSql).toContain('INCLUDE (chain_tx_id)');
    expect(createSql).toContain("WHERE deleted_at IS NULL AND metadata ? 'pipeline_source'");
    expect(cleanupSql).toContain(`LIKE '${PIPELINE_DASHBOARD_SUPPORT_INDEX_REBUILD_JOB_PREFIX}%`);
    expect(cleanupSql).toContain('cron.unschedule(v_job.jobid)');
    expect(enableTimeoutBypassSql).toBe('ALTER ROLE postgres IN DATABASE postgres SET statement_timeout = 0;');
    expect(resetTimeoutBypassSql).toBe('ALTER ROLE postgres IN DATABASE postgres RESET statement_timeout;');
    expect(schedule).toEqual({
      jobName: `${PIPELINE_DASHBOARD_SUPPORT_INDEX_REBUILD_JOB_PREFIX}-202605061944`,
      schedule: '44 19 6 5 *',
      scheduledForUtc: '2026-05-06T19:44:00.000Z',
    });
    expect(scheduleSql).toContain(`'${schedule.jobName}'`);
    expect(scheduleSql).toContain(`'${schedule.schedule}'`);
    expect(scheduleSql).toContain(`CREATE INDEX CONCURRENTLY ${PIPELINE_DASHBOARD_SUPPORT_INDEX_NAME}`);
  });

  it('builds a fast stats function that removes the invalid support-index dependency', () => {
    const sql = buildInstallFastPipelineStatsFunctionSql();

    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.refresh_cache_pipeline_stats()');
    expect(sql).toContain("SET statement_timeout TO '20s'");
    expect(sql).toContain('scrum_1708_fast_stats');
    expect(sql).toContain(PIPELINE_DASHBOARD_FAST_STATS_FUNCTION_COMMENT);
    expect(sql).not.toContain("metadata ? 'pipeline_source'");
  });
});
