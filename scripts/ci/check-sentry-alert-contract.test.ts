import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type SentryAlertRule = {
  name: string;
  filters?: Array<{ key?: string; value?: string }>;
  actions?: Array<{ tags?: string }>;
};

const repoRoot = process.cwd();

function readRevisionDriftWorkflow(): string {
  return fs.readFileSync(path.join(repoRoot, '.github/workflows/revision-drift.yml'), 'utf8');
}

function readAlertRules(): { rules: SentryAlertRule[] } {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'infra/sentry/alert-rules.json'), 'utf8')) as {
    rules: SentryAlertRule[];
  };
}

describe('revision drift Sentry alert contract', () => {
  it('emits the tags that the documented Sentry rule filters and Slack action require', () => {
    const workflow = readRevisionDriftWorkflow();
    const { rules } = readAlertRules();
    const rule = rules.find((candidate) => candidate.name.includes('Cloud Run revision drift'));

    expect(rule).toBeDefined();
    expect(rule?.filters).toContainEqual(
      expect.objectContaining({
        key: 'source',
        value: 'revision-drift',
      }),
    );

    const slackTags = rule?.actions?.flatMap((action) => action.tags?.split(',') ?? []) ?? [];
    expect(slackTags).toEqual(expect.arrayContaining(['story', 'deployed_sha', 'head_sha']));

    expect(workflow).toContain('source: "revision-drift"');
    expect(workflow).toContain('story: "SCRUM-1247"');
    expect(workflow).toContain('deployed_sha: $live');
    expect(workflow).toContain('head_sha: $head');
  });
});
