/**
 * SCRUM-3050 — pipeline-throughput dead-man Sentry alert contract.
 *
 * "event ≠ alert." The monitor detected the 70h anchoring outage perfectly and
 * fired for 70+ hours; no human saw it, because (a) no issue-alert rule routed
 * its events anywhere, and (b) the capture helper stamped `source`/`story` into
 * `extra` rather than TAGS, so a `TaggedEventFilter` rule could not have matched
 * it even if one had existed. This test is the build-time guard that the CODE
 * and the RULES stay in lockstep — mirroring
 * `check-ce-key-expiry-alert-contract.test.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type SentryAlertRule = {
  name: string;
  filters?: Array<{ key?: string; value?: string; match?: string; level?: string; id?: string }>;
  actions?: Array<{ id?: string; channel?: string; tags?: string }>;
  frequency?: number;
};

const repoRoot = process.cwd();

function readAlertRules(): { rules: SentryAlertRule[] } {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'infra/sentry/alert-rules.json'), 'utf8'),
  ) as { rules: SentryAlertRule[] };
}

const monitorSource = fs.readFileSync(
  path.join(repoRoot, 'services/worker/src/jobs/pipelineThroughputMonitor.ts'),
  'utf8',
);
const sentrySource = fs.readFileSync(
  path.join(repoRoot, 'services/worker/src/utils/sentry.ts'),
  'utf8',
);

describe('SCRUM-3050 pipeline-throughput dead-man alert contract', () => {
  const { rules } = readAlertRules();
  const baseline = rules.find((r) => r.name === 'SCRUM-3050 — Pipeline throughput dead-man');
  const sustained = rules.find((r) =>
    r.name === 'SCRUM-3050 — Pipeline throughput dead-man SUSTAINED (72h+)',
  );

  it('a baseline rule exists and routes to a human Slack channel', () => {
    expect(baseline, 'the working dead-man had NO alert rule at all — that is the bug').toBeDefined();
    const slack = baseline?.actions?.find((a) => a.id?.includes('SlackNotifyServiceAction'));
    expect(slack, 'rule must page a human — event ≠ alert').toBeDefined();
    expect(slack?.channel).toBe('#ops');
  });

  it('a SUSTAINED escalation rule exists on a separate, louder route', () => {
    expect(sustained).toBeDefined();
    const slack = sustained?.actions?.find((a) => a.id?.includes('SlackNotifyServiceAction'));
    expect(slack?.channel).toBe('#ops');
    // A sustained outage must not be throttled more than the baseline.
    expect(sustained?.frequency ?? Infinity).toBeLessThanOrEqual(baseline?.frequency ?? Infinity);
  });

  it('the capture helper emits real TAGS, not just `extra` (a tag rule cannot match extras)', () => {
    expect(sentrySource).toContain("PIPELINE_THROUGHPUT_ALERT_SOURCE = 'pipeline-throughput-monitor'");
    // The `tags:` block must exist inside capturePipelineThroughputAlert.
    const helper = sentrySource.slice(
      sentrySource.indexOf('export function capturePipelineThroughputAlert'),
    );
    expect(helper.slice(0, 1500)).toContain('tags: {');
    expect(helper.slice(0, 1500)).toContain('source: PIPELINE_THROUGHPUT_ALERT_SOURCE');
  });

  it('both rules filter on the exact source tag the helper emits', () => {
    for (const rule of [baseline, sustained]) {
      expect(rule?.filters).toContainEqual(
        expect.objectContaining({ key: 'source', value: 'pipeline-throughput-monitor' }),
      );
    }
  });

  it('the SUSTAINED rule gates on fatal (50) while the baseline gates on error (40)', () => {
    const baselineLevel = baseline?.filters?.find((f) => f.id?.includes('LevelFilter'));
    const sustainedLevel = sustained?.filters?.find((f) => f.id?.includes('LevelFilter'));
    expect(baselineLevel?.match).toBe('gte');
    expect(sustainedLevel?.match).toBe('gte');
    expect(Number(baselineLevel?.level)).toBe(40);
    expect(Number(sustainedLevel?.level)).toBe(50);
    expect(Number(sustainedLevel?.level)).toBeGreaterThan(Number(baselineLevel?.level));
  });

  it('the Slack actions carry the tags a responder needs, and the code emits them', () => {
    for (const rule of [baseline, sustained]) {
      const tags = rule?.actions?.flatMap((a) => a.tags?.split(',').map((t) => t.trim()) ?? []) ?? [];
      expect(tags).toEqual(expect.arrayContaining(['story', 'sustained_bucket', 'alert_type']));
    }
    for (const tag of ['story', 'alert_type', 'sustained_bucket']) {
      expect(sentrySource, `helper must emit the '${tag}' tag`).toContain(`${tag}:`);
    }
  });

  it('the fingerprint is bucketed so an escalation opens a NEW issue', () => {
    expect(sentrySource).toContain('...PIPELINE_THROUGHPUT_FINGERPRINT, bucket');
    expect(monitorSource).toContain('sustainedBucket: decision.sustained_bucket');
  });

  it('an unbounded duration escalates to the TOP bucket (fail loud, not fail quiet)', () => {
    expect(monitorSource).toMatch(/if \(hours === null\) return 't168h'/);
  });
});
