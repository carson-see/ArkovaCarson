/**
 * SCRUM-3050 — Cloud Scheduler job-failure alert contract.
 *
 * A Cloud Scheduler job that fires on cadence and gets a 404 leaves NO
 * worker-side trace: no worker log, no Sentry event, no dead-man tick, no
 * `/health` degradation. Every in-repo monitor is structurally blind to it.
 * `generate-reports` returned NOT_FOUND on every hourly run from 2026-03-16 —
 * roughly 3,300 consecutive failures over 4.5 months — and nothing alerted.
 *
 * The only place that failure is observable is the Cloud Scheduler log stream,
 * so the alarm has to live in GCP Monitoring. This test pins the two artifacts
 * that make it work (the log-based metric and the alert policy) to each other
 * and to the log shape verified against production on 2026-08-01.
 *
 * NOTE ON SCOPE: this test proves the CONFIG is coherent. It cannot prove the
 * policy is applied in GCP or that a notification channel exists — see the
 * FOUNDER ACTIONS in the SCRUM-3050 handoff. As of 2026-08-01 project `arkova1`
 * had ZERO alert policies, ZERO notification channels and ZERO log-based
 * metrics, so every JSON under scripts/gcp-setup/ is declared-only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

type LogMetric = {
  name: string;
  filter: string;
  metricDescriptor?: { metricKind?: string; valueType?: string; labels?: Array<{ key: string }> };
  labelExtractors?: Record<string, string>;
};

type AlertPolicy = {
  displayName: string;
  documentation?: { content?: string };
  conditions: Array<{
    displayName?: string;
    conditionThreshold?: {
      filter?: string;
      aggregations?: Array<{
        alignmentPeriod?: string;
        perSeriesAligner?: string;
        crossSeriesReducer?: string;
        groupByFields?: string[];
      }>;
      comparison?: string;
      thresholdValue?: number;
      duration?: string;
      evaluationMissingData?: string;
    };
  }>;
  combiner?: string;
  enabled?: boolean;
  notificationChannels?: string[];
  severity?: string;
};

const metric = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, 'scripts/gcp-setup/log-metrics/cloud-scheduler-job-failure.json'),
    'utf8',
  ),
) as LogMetric;

const policy = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, 'scripts/gcp-setup/alert-policies/cloud-scheduler-job-failure-page.json'),
    'utf8',
  ),
) as AlertPolicy;

const applyScript = fs.readFileSync(
  path.join(repoRoot, 'scripts/gcp-setup/apply-monitoring.sh'),
  'utf8',
);

describe('SCRUM-3050 Cloud Scheduler job-failure alert contract', () => {
  it('the log-based metric selects Cloud Scheduler attempt failures (shape verified against prod 2026-08-01)', () => {
    expect(metric.filter).toContain('resource.type="cloud_scheduler_job"');
    // AttemptStarted entries must NOT be counted — only finished attempts carry
    // a failure status, and counting starts would double every failure.
    expect(metric.filter).toContain(
      'type.googleapis.com/google.cloud.scheduler.logging.AttemptFinished',
    );
    expect(metric.filter).toContain('severity>=ERROR');
    expect(metric.filter).not.toContain('AttemptStarted');
  });

  it('the metric is a DELTA counter so ALIGN_SUM over a window is meaningful', () => {
    expect(metric.metricDescriptor?.metricKind).toBe('DELTA');
    expect(metric.metricDescriptor?.valueType).toBe('INT64');
  });

  it('the metric extracts job_id and status so an alert can name the broken job', () => {
    expect(Object.keys(metric.labelExtractors ?? {})).toEqual(
      expect.arrayContaining(['job_id', 'status']),
    );
    expect(metric.labelExtractors?.job_id).toBe('EXTRACT(resource.labels.job_id)');
    expect(metric.labelExtractors?.status).toBe('EXTRACT(jsonPayload.status)');
    const declared = (metric.metricDescriptor?.labels ?? []).map((l) => l.key);
    for (const key of Object.keys(metric.labelExtractors ?? {})) {
      expect(declared, `label '${key}' must be declared on the descriptor`).toContain(key);
    }
  });

  it('the alert policy reads the metric this repo actually defines', () => {
    const expectedType = `logging.googleapis.com/user/${metric.name}`;
    for (const condition of policy.conditions) {
      expect(condition.conditionThreshold?.filter).toContain(expectedType);
    }
  });

  it('every condition groups by job_id so one broken job does not hide behind fleet totals', () => {
    for (const condition of policy.conditions) {
      const agg = condition.conditionThreshold?.aggregations?.[0];
      expect(agg?.perSeriesAligner).toBe('ALIGN_SUM');
      expect(agg?.groupByFields).toContain('metric.label.job_id');
    }
  });

  it('has a consecutive-failure condition: failures in every hourly bucket for 3h', () => {
    const consecutive = policy.conditions.find(
      (c) => c.conditionThreshold?.aggregations?.[0]?.alignmentPeriod === '3600s',
    );
    expect(consecutive, 'hourly-cadence jobs need a consecutive-hours condition').toBeDefined();
    expect(consecutive?.conditionThreshold?.comparison).toBe('COMPARISON_GT');
    expect(consecutive?.conditionThreshold?.thresholdValue).toBe(0);
    // 3 consecutive hourly buckets. `generate-reports` (0 * * * *) would have
    // paged within 3 hours of 2026-03-16 instead of 4.5 months later.
    expect(Number.parseInt(consecutive?.conditionThreshold?.duration ?? '0', 10)).toBe(10800);
  });

  it('has a daily-volume condition so jobs running less often than hourly are still covered', () => {
    const daily = policy.conditions.find(
      (c) => c.conditionThreshold?.aggregations?.[0]?.alignmentPeriod === '86400s',
    );
    expect(daily, 'a 6-hourly job never fills 3 consecutive hourly buckets').toBeDefined();
    expect(daily?.conditionThreshold?.comparison).toBe('COMPARISON_GT');
    // >2 in 24h — a single transient blip must NOT page.
    expect(daily?.conditionThreshold?.thresholdValue).toBe(2);
  });

  it('conditions are OR-combined and absent data is treated as healthy, not as a fire', () => {
    expect(policy.combiner).toBe('OR');
    for (const condition of policy.conditions) {
      expect(condition.conditionThreshold?.evaluationMissingData).toBe(
        'EVALUATION_MISSING_DATA_INACTIVE',
      );
    }
  });

  it('the policy is enabled, CRITICAL, and templated to a notification channel', () => {
    expect(policy.enabled).toBe(true);
    expect(policy.severity).toBe('CRITICAL');
    // A policy with no channel notifies nobody — the exact failure this story exists to end.
    expect(policy.notificationChannels?.length ?? 0).toBeGreaterThan(0);
    expect(policy.notificationChannels?.[0]).toBe('${SLACK_OPS_ALERTS_CHANNEL}');
  });

  it('the documentation names the triage path rather than just the symptom', () => {
    const doc = policy.documentation?.content ?? '';
    expect(doc).toContain('NOT_FOUND');
    expect(doc).toContain('DEADLINE_EXCEEDED');
    expect(doc).toContain('scheduler-manifest.ts');
  });

  it('apply-monitoring.sh actually applies log-based metrics before alert policies', () => {
    expect(applyScript).toContain('ensure_log_based_metrics');
    expect(applyScript).toContain('logging.googleapis.com/v2/projects/${PROJECT_ID}/metrics');
    const metricsIdx = applyScript.lastIndexOf('  ensure_log_based_metrics');
    const policiesIdx = applyScript.lastIndexOf('  ensure_alert_policies');
    expect(metricsIdx).toBeGreaterThan(-1);
    expect(policiesIdx).toBeGreaterThan(metricsIdx);
  });
});
