import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const workflow = readFileSync(resolve(repoRoot, '.github/workflows/deploy-worker.yml'), 'utf8');

describe('Deploy Worker pre-deploy Git history contract', () => {
  it('checks out full history before running history-bound worker tests', () => {
    const preDeployJob = workflow.match(/\n {2}pre-deploy-checks:\n([\s\S]*?)\n {2}deploy:\n/)?.[1];

    expect(preDeployJob).toBeDefined();
    expect(preDeployJob).toMatch(
      /- uses: actions\/checkout@[0-9a-f]+[^\n]*\n\s+with:\n(?:\s+#.*\n)*\s+fetch-depth: 0/u,
    );
    expect(preDeployJob?.indexOf('fetch-depth: 0')).toBeLessThan(
      preDeployJob?.indexOf('run: npm test') ?? -1,
    );
  });
});
