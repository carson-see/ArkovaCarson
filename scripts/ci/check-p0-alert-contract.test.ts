/**
 * Contract tests binding the 2026-08-11 P0 alarms to the code that feeds them.
 *
 * Every one of these alarms is a two-sided contract between a file in
 * `scripts/gcp-setup/` and something else — a log line the worker emits, a
 * metric another file declares, or a response body a route returns. Each side
 * can be edited alone, and when it is, the alarm does not break loudly: it
 * stops matching and goes quiet. A quiet alarm is indistinguishable from a
 * healthy system, which is the precise failure this whole change exists to
 * remove. So the pairings are pinned here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GCP = join(REPO, 'scripts', 'gcp-setup');

function json(...p: string[]): Record<string, any> {
  return JSON.parse(readFileSync(join(GCP, ...p), 'utf8'));
}

const lockMetric = json('log-metrics', 'db-lock-wait.json');
const lockPolicy = json('alert-policies', 'db-lock-wait-page.json');
const pgrstMetric = json('log-metrics', 'postgrest-schema-cache-failure.json');
const pgrstPolicy = json('alert-policies', 'postgrest-schema-cache-failure-page.json');
const healthPolicy = json('alert-policies', 'worker-health-body-degraded-page.json');
const healthUptime = json('uptime-checks', 'worker-health-body.json');
const fivexxPolicy = json('alert-policies', 'worker-5xx-burst-page.json');

const emitter = readFileSync(
  join(REPO, 'services', 'worker', 'src', 'jobs', 'lock-wait-monitor.ts'),
  'utf8',
);

// Read the constant out of the SOURCE rather than importing it. Importing the
// emitter drags in utils/db.js -> config.ts, which hard-fails without the
// worker's full runtime env — a CI-only contract check must not need Stripe
// keys to answer "do these two files agree".
const LOCK_WAIT_ALERT_TYPE = (() => {
  const m = /export const LOCK_WAIT_ALERT_TYPE\s*=\s*'([^']+)'/.exec(emitter);
  if (!m) throw new Error('LOCK_WAIT_ALERT_TYPE not found in lock-wait-monitor.ts');
  return m[1];
})();

describe('db_lock_wait: emitter <-> log-based metric', () => {
  it('the metric filters on the literal the emitter actually writes', () => {
    expect(LOCK_WAIT_ALERT_TYPE).toBe('db_lock_wait');
    expect(lockMetric.filter).toContain(`jsonPayload.alert_type="${LOCK_WAIT_ALERT_TYPE}"`);
  });

  it('the metric only counts the prod worker, not soak rigs', () => {
    expect(lockMetric.filter).toContain('resource.labels.service_name="arkova-worker"');
  });

  it('every metric label extractor reads a field the emitter emits', () => {
    for (const [label, extractor] of Object.entries(lockMetric.labelExtractors as Record<string, string>)) {
      const m = /^EXTRACT\(jsonPayload\.(\w+)\)$/.exec(extractor);
      expect(m, `label "${label}" must extract a jsonPayload field, got ${extractor}`).toBeTruthy();
      const field = m![1];
      expect(emitter, `emitter must log jsonPayload.${field} for metric label "${label}"`).toContain(
        `${field}:`,
      );
    }
  });

  it('the policy points at the metric this repo declares', () => {
    expect(lockPolicy.conditions[0].conditionThreshold.filter).toContain(
      `logging.googleapis.com/user/${lockMetric.name}`,
    );
  });

  it('the policy groups by a label the metric actually defines', () => {
    const groupBy: string[] = lockPolicy.conditions[0].conditionThreshold.aggregations[0].groupByFields ?? [];
    const declared = Object.keys(lockMetric.labelExtractors ?? {});
    for (const g of groupBy) {
      const label = g.replace('metric.label.', '');
      expect(declared, `policy groups by "${label}" which the metric does not declare`).toContain(label);
    }
  });

  it('fires on presence, not on a rate — one barrier is one page', () => {
    const c = lockPolicy.conditions[0].conditionThreshold;
    expect(c.comparison).toBe('COMPARISON_GT');
    expect(c.thresholdValue).toBe(0);
    expect(c.duration).toBe('0s');
  });
});

describe('PGRST002: metric <-> policy', () => {
  it('matches PostgREST schema-cache failures on the prod worker', () => {
    expect(pgrstMetric.filter).toContain('resource.labels.service_name="arkova-worker"');
    expect(pgrstMetric.filter).toContain('PGRST002');
  });

  it('matches BOTH the structured error code and free-text occurrences', () => {
    // Several 2026-08-11 call sites logged the code only inside a message
    // string. Dropping either arm silently narrows the alarm.
    expect(pgrstMetric.filter).toContain('jsonPayload.error.code="PGRST002"');
    expect(pgrstMetric.filter).toContain('"PGRST002"');
  });

  it('the policy points at the metric this repo declares', () => {
    expect(pgrstPolicy.conditions[0].conditionThreshold.filter).toContain(
      `logging.googleapis.com/user/${pgrstMetric.name}`,
    );
  });

  it('fires on any occurrence in a 5-minute window', () => {
    const c = pgrstPolicy.conditions[0].conditionThreshold;
    expect(c.aggregations[0].alignmentPeriod).toBe('300s');
    expect(c.comparison).toBe('COMPARISON_GT');
    expect(c.thresholdValue).toBe(0);
  });
});

describe('/health: uptime check asserts the BODY, not just the status code', () => {
  it('has a content matcher — a 2xx-only check is blind to the actual outage', () => {
    // On 2026-08-11 /health returned HTTP 200 with a "degraded" body for
    // 11m39s. Status-code-only monitoring saw nothing wrong for the entire
    // outage. The content matcher IS the fix; without it this check is theatre.
    expect(healthUptime.contentMatchers).toBeDefined();
    expect(healthUptime.contentMatchers.length).toBeGreaterThan(0);
    expect(healthUptime.contentMatchers[0].matcher).toBe('CONTAINS_STRING');
    expect(healthUptime.contentMatchers[0].content).toBe('"status":"healthy"');
  });

  it('checks the /health path on the prod worker host', () => {
    expect(healthUptime.httpCheck.path).toBe('/health');
    expect(healthUptime.httpCheck.useSsl).toBe(true);
    expect(healthUptime.monitoredResource.labels.host).toContain('arkova-worker');
  });

  it('the matcher string is the shape the route actually serves', () => {
    // Captured live from prod on 2026-08-11:
    //   {"status":"healthy","version":"0.1.0",...}
    // Serialized with no space after the colon, so the matcher must not have
    // one either. This is the single most likely way to build a check that
    // fails 100% of the time and gets muted as noise.
    const sample = '{"status":"healthy","version":"0.1.0","checks":{"database":"ok"}}';
    expect(sample).toContain(healthUptime.contentMatchers[0].content);
  });

  it('alerts on a sustained failure, roughly 3 consecutive checks', () => {
    const c = healthPolicy.conditions[0].conditionThreshold;
    expect(healthUptime.period).toBe('60s');
    expect(c.comparison).toBe('COMPARISON_LT');
    expect(c.duration).toBe('180s');
  });
});

describe('5xx burst', () => {
  it('watches the prod worker 5xx class specifically', () => {
    const f = fivexxPolicy.conditions[0].conditionThreshold.filter;
    expect(f).toContain('run.googleapis.com/request_count');
    expect(f).toContain('resource.label.service_name="arkova-worker"');
    expect(f).toContain('metric.label.response_code_class="5xx"');
  });

  it('keeps the threshold above the measured background drip', () => {
    // 7-day census on 2026-08-11: 496 five-minute buckets contained exactly one
    // 5xx, and every bucket above 5 fell inside the P0 window. A threshold at
    // or below 1 would page ~70x/week on known background and get muted.
    expect(fivexxPolicy.conditions[0].conditionThreshold.thresholdValue).toBeGreaterThan(4);
  });
});

describe('every P0 alarm routes somewhere a human reads', () => {
  const policies = [
    ['db-lock-wait', lockPolicy],
    ['postgrest-schema-cache', pgrstPolicy],
    ['health-body', healthPolicy],
    ['5xx-burst', fivexxPolicy],
  ] as const;

  it.each(policies)('%s declares a notification channel', (_name, policy) => {
    // An alert wired to nothing reproduces the incident exactly: it fires,
    // and nobody finds out.
    expect(policy.notificationChannels).toBeDefined();
    expect(policy.notificationChannels.length).toBeGreaterThan(0);
  });

  it.each(policies)('%s is enabled and severity-tagged', (_name, policy) => {
    expect(policy.enabled).toBe(true);
    expect(policy.severity).toBe('CRITICAL');
  });

  it.each(policies)('%s carries a documentation runbook', (_name, policy) => {
    // The person woken up at 03:00 is not the person who wrote the filter.
    expect(policy.documentation?.content?.length ?? 0).toBeGreaterThan(200);
  });
});

describe('the prevention linter is actually wired into CI', () => {
  it('ci.yml invokes check-hot-table-ddl-lock-timeout.ts', () => {
    const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toContain('scripts/ci/check-hot-table-ddl-lock-timeout.ts');
  });

  it('the linter and its baseline both exist', () => {
    expect(existsSync(join(REPO, 'scripts', 'ci', 'check-hot-table-ddl-lock-timeout.ts'))).toBe(true);
    expect(
      existsSync(join(REPO, 'scripts', 'ci', 'snapshots', 'hot-table-ddl-lock-timeout-baseline.json')),
    ).toBe(true);
  });
});
