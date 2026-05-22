import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const gcpSetupDir = path.join(repoRoot, 'scripts/gcp-setup');

const requiredSloIds = [
  'worker-availability',
  'worker-p95-latency',
  'batch-anchor-success',
  'verification-api-p95-latency',
] as const;

const requiredCustomMetricDescriptors = [
  'batch-anchor-run-result.json',
  'gemini-token-burn.json',
  'verification-api-request-latency.json',
] as const;

interface MetricDescriptorLabel {
  key?: string;
}

interface MonitoringMetricDescriptor {
  type?: string;
  metricKind?: string;
  valueType?: string;
  labels?: MetricDescriptorLabel[];
}

interface MonitoringDashboard {
  displayName?: string;
  mosaicLayout?: { tiles?: Array<{ widget?: { title?: string; xyChart?: unknown } }> };
}

interface MonitoringAlertPolicy {
  displayName?: string;
  notificationChannels?: string[];
  conditions?: Array<{
    displayName?: string;
    conditionThreshold?: { filter?: string; comparison?: string; thresholdValue?: number };
  }>;
  documentation?: { content?: string };
  severity?: string;
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(read(relativePath)) as T;
}

describe('GCP-MAX-04 monitoring contract', () => {
  it('defines the four parent-story SLOs and provisions the same set explicitly', () => {
    const provision = read('scripts/gcp-setup/provision.sh');

    for (const sloId of requiredSloIds) {
      const sloPath = path.join(gcpSetupDir, 'slos', `${sloId}.yaml`);
      expect(fs.existsSync(sloPath), `${sloId} SLO file missing`).toBe(true);

      const slo = fs.readFileSync(sloPath, 'utf8');
      expect(slo).toContain('displayName:');
      expect(slo).toContain('goal:');
      expect(slo).toMatch(/(rollingPeriod|calendarPeriod):/);
      expect(slo).toContain('serviceLevelIndicator:');
      expect(provision).toContain(sloId);
    }

    expect(provision).not.toContain('|| echo "SLO $SLO already exists or failed');

    const batchAnchorSlo = read('scripts/gcp-setup/slos/batch-anchor-success.yaml');
    expect(batchAnchorSlo).toContain('metric.labels.synthetic = "false"');
  });

  it('keeps every custom metric used by monitoring backed by descriptor config', () => {
    for (const filename of requiredCustomMetricDescriptors) {
      const descriptor = readJson<MonitoringMetricDescriptor>(
        `scripts/gcp-setup/metrics/${filename}`,
      );

      expect(descriptor.type).toMatch(/^custom\.googleapis\.com\/arkova\//);
      expect(descriptor.metricKind).toMatch(/^(DELTA|GAUGE|CUMULATIVE)$/);
      expect(descriptor.valueType).toMatch(/^(INT64|DOUBLE|DISTRIBUTION|BOOL)$/);
      expect(descriptor.labels?.some((label) => label.key === 'environment')).toBe(true);
      expect(descriptor.labels?.some((label) => label.key === 'synthetic')).toBe(true);
    }
  });

  it('ships dashboards-as-code for all parent-story dashboard surfaces', () => {
    const dashboard = readJson<MonitoringDashboard>(
      'scripts/gcp-setup/dashboards/arkova-ops-health.json',
    );

    const titles = dashboard.mosaicLayout?.tiles?.map((tile) => tile.widget?.title ?? '') ?? [];

    expect(dashboard.displayName).toBe('Arkova Operations Health');
    expect(titles).toEqual(
      expect.arrayContaining([
        'Cloud Run worker 2xx throughput',
        'Cloud Run worker latency',
        'Edge function request outcomes',
        'Batch anchor run outcomes',
        'Gemini Golden token burn rate',
      ]),
    );
  });

  it('ships 1x info and 2x page burn-rate alert policy templates for every SLO', () => {
    for (const sloId of requiredSloIds) {
      for (const burn of ['1x-info', '2x-page'] as const) {
        const policy = readJson<MonitoringAlertPolicy>(
          `scripts/gcp-setup/alert-policies/${sloId}-${burn}.json`,
        );

        const threshold = burn === '1x-info' ? 1 : 2;
        const severity = burn === '1x-info' ? 'WARNING' : 'CRITICAL';

        expect(policy.displayName).toContain(sloId);
        expect(policy.notificationChannels).toContain(`\${SLACK_OPS_ALERTS_CHANNEL}`);
        expect(policy.conditions?.[0]?.conditionThreshold?.filter).toContain(
          `serviceLevelObjectives/${sloId}`,
        );
        expect(policy.conditions?.[0]?.displayName).toContain(`> ${threshold}x`);
        expect(policy.conditions?.[0]?.conditionThreshold?.comparison).toBe('COMPARISON_GT');
        expect(policy.conditions?.[0]?.conditionThreshold?.thresholdValue).toBe(threshold);
        expect(policy.documentation?.content).toContain(`above ${threshold}x`);
        expect(policy.severity).toBe(severity);
      }
    }
  });

  it('reconciles existing alert policies on re-run instead of drifting', () => {
    const applyMonitoring = read('scripts/gcp-setup/apply-monitoring.sh');

    expect(applyMonitoring).toContain('gcloud monitoring policies update "$existing"');
    expect(applyMonitoring).toContain('--policy-from-file="$rendered"');
  });

  it('keeps the synthetic burn harness operator-gated and clearly labeled', () => {
    const harness = read('scripts/gcp-setup/synthetic-burn.sh');

    expect(harness).toContain('ALLOW_SYNTHETIC_SLO_BURN');
    expect(harness).toContain('GCP_PROJECT_ID must be set explicitly');
    expect(harness).toContain('BATCH_METRIC_SYNTHETIC_LABEL="false"');
    expect(harness).toContain('so Cloud Monitoring includes it in the SLO filter');
    expect(harness).toContain('synthetic');
    expect(harness).toContain('custom.googleapis.com/arkova/batch_anchor_run_result');
    expect(harness).toContain('custom.googleapis.com/arkova/gemini_token_burn');
    expect(harness).toContain('--connect-timeout 10');
    expect(harness).toContain('--max-time 60');
    expect(harness).toContain('--retry 3');
  });
});
