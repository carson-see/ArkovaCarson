import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const workflow = readFileSync(resolve(repoRoot, '.github/workflows/deploy-worker.yml'), 'utf8');

/** Return checkout step blocks occurring before the worker-test command. */
function checkoutStepsBeforeWorkerTests(job: string): string[] {
  const testCommandIndex = job.indexOf('run: npm test');
  if (testCommandIndex < 0) return [];

  const lines = job.slice(0, testCommandIndex).split('\n');
  const starts = lines.flatMap((line, index) => (
    /^\s*-\s+uses:\s*actions\/checkout@/u.test(line) ? [index] : []
  ));

  return starts.map((start) => {
    const indent = lines[start]?.slice(0, lines[start]?.indexOf('-')) ?? '';
    const nextStep = lines.findIndex((line, index) => (
      index > start && line.startsWith(`${indent}- `)
    ));
    return lines.slice(start, nextStep < 0 ? lines.length : nextStep).join('\n');
  });
}

describe('Deploy Worker pre-deploy Git history contract', () => {
  it('uses an isolated full-history checkout for history-bound worker tests', () => {
    const preDeployJob = workflow.match(/\n {2}pre-deploy-checks:\n([\s\S]*?)\n {2}deploy:\n/)?.[1];

    expect(preDeployJob).toBeDefined();
    const checkoutSteps = checkoutStepsBeforeWorkerTests(preDeployJob ?? '');
    const effectiveCheckout = checkoutSteps.at(-1) ?? '';

    expect(checkoutSteps.length).toBeGreaterThan(0);
    expect([...effectiveCheckout.matchAll(/^\s+fetch-depth:\s*(\S+)/gmu)]
      .map((match) => match[1])).toEqual(['0']);
    expect([...effectiveCheckout.matchAll(/^\s+persist-credentials:\s*(\S+)/gmu)]
      .map((match) => match[1])).toEqual(['false']);
  });

  it('selects the last checkout before tests as the effective checkout', () => {
    const job = `
      - uses: actions/checkout@1111111111111111111111111111111111111111
        with:
          fetch-depth: 0
      - uses: actions/checkout@2222222222222222222222222222222222222222
        with:
          fetch-depth: 1
      - name: Test
        run: npm test
    `;

    expect(checkoutStepsBeforeWorkerTests(job).at(-1)).toContain('fetch-depth: 1');
  });
});
