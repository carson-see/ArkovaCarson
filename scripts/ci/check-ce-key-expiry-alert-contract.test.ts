/**
 * SCRUM-2902 — CE key expiry Sentry alert contract.
 *
 * "event ≠ alert": the job emitting a Sentry event does not, by itself, page a
 * human. Delivery requires a Sentry issue-alert rule whose tag filters match the
 * emitted event AND whose Slack action routes to a human channel with the tags
 * the responder needs. This test is the build-time guard that the CODE
 * (`services/worker/src/jobs/ce-key-expiry-alert.ts`) and the RULE
 * (`infra/sentry/alert-rules.json`) stay in lockstep — mirroring
 * `check-sentry-alert-contract.test.ts` for revision-drift.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type SentryAlertRule = {
  name: string;
  filters?: Array<{ key?: string; value?: string; match?: string; level?: string; id?: string }>;
  actions?: Array<{ id?: string; channel?: string; tags?: string }>;
};

const repoRoot = process.cwd();

function readAlertRules(): { rules: SentryAlertRule[] } {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'infra/sentry/alert-rules.json'), 'utf8'),
  ) as { rules: SentryAlertRule[] };
}

function readJobSource(): string {
  return fs.readFileSync(
    path.join(repoRoot, 'services/worker/src/jobs/ce-key-expiry-alert.ts'),
    'utf8',
  );
}

describe('SCRUM-2902 CE key expiry Sentry alert contract', () => {
  const { rules } = readAlertRules();
  const rule = rules.find((r) => r.name.includes('Credential Engine API key expiry'));
  const job = readJobSource();

  it('the alert rule exists and routes to a human Slack channel', () => {
    expect(rule).toBeDefined();
    const slackAction = rule?.actions?.find((a) =>
      a.id?.includes('SlackNotifyServiceAction'),
    );
    expect(slackAction, 'rule must page a human via Slack — event ≠ alert').toBeDefined();
    expect(slackAction?.channel).toBe('#ops');
  });

  it('the rule filters on the exact source tag the job emits', () => {
    // Code side: the job stamps source='ce-key-expiry'.
    expect(job).toContain("CE_KEY_EXPIRY_ALERT_SOURCE = 'ce-key-expiry'");
    expect(job).toContain('source: CE_KEY_EXPIRY_ALERT_SOURCE');
    // Rule side: the filter must key on the same value.
    expect(rule?.filters).toContainEqual(
      expect.objectContaining({ key: 'source', value: 'ce-key-expiry' }),
    );
  });

  it('the Slack action carries every tag the job emits and the responder needs', () => {
    const slackTags =
      rule?.actions?.flatMap((a) => a.tags?.split(',').map((t) => t.trim()) ?? []) ?? [];
    // These three are the actionable fields: which story, which window, days left.
    expect(slackTags).toEqual(
      expect.arrayContaining(['story', 'expiry_window', 'days_until_expiry']),
    );
    // And the job must actually emit each of those tag keys.
    for (const tag of ['story', 'expiry_window', 'days_until_expiry']) {
      expect(job, `job must emit the '${tag}' tag the Slack action references`).toContain(
        `${tag}:`,
      );
    }
  });

  it('the rule pages on warning-or-higher so both T-30/T-14 (warning) and T-7/EXPIRED/SENTINEL (error) reach a human', () => {
    const levelFilter = rule?.filters?.find((f) => f.id?.includes('LevelFilter'));
    expect(levelFilter).toBeDefined();
    expect(levelFilter?.match).toBe('gte');
    // level 30 = warning in Sentry's numeric scale.
    expect(Number(levelFilter?.level)).toBeLessThanOrEqual(30);
  });

  it('the fail-LOUD sentinel path is present in the job (unset date must FIRE)', () => {
    expect(job).toContain("window: 'SENTINEL'");
    expect(job).toMatch(/should_fire:\s*true/);
    // The sentinel branch must be error severity so it clears the warning gate.
    expect(job).toContain('CE_KEY_EXPIRY_SENTINEL_VALUES');
  });
});
