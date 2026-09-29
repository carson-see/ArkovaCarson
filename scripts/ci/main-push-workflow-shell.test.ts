import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

interface Workflow {
  jobs: { admission: { steps: Array<{ name?: string; run?: string }> } };
}

const workflow = load(readFileSync('.github/workflows/ci.yml', 'utf8')) as Workflow;
const decisionStep = workflow.jobs.admission.steps.find((step) =>
  step.name === 'Admit protected, ready, and speculative runs');
if (!decisionStep?.run) throw new Error('admission decision shell not found');
const decisionShell: string = decisionStep.run;

function execute(env: Record<string, string>): Record<string, string> {
  const output = join(mkdtempSync(join(tmpdir(), 'arkova-admission-shell-')), 'output');
  execFileSync('/bin/bash', ['-euo', 'pipefail', '-c', decisionShell], {
    env: { ...process.env, GITHUB_OUTPUT: output, ...env },
  });
  return Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

describe('actual CI admission decision shell', () => {
  it('routes a classified protected-main T0 push to focused validation', () => {
    expect(execute({
      GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main',
      DEFAULT_RUN_FULL: 'true', MAIN_PUSH_RUN_FULL: 'false', MAIN_PUSH_RUN_FOCUSED: 'true',
    })).toEqual({ run_full: 'false', run_focused: 'true' });
  });

  it('fails closed when protected-main classifier outputs are unavailable', () => {
    expect(execute({
      GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main',
      DEFAULT_RUN_FULL: 'true', MAIN_PUSH_RUN_FULL: '', MAIN_PUSH_RUN_FOCUSED: '',
    })).toEqual({ run_full: 'true', run_focused: 'false' });
  });

  it('preserves ready/manual full runs and ordinary draft skips', () => {
    expect(execute({
      GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/1/merge',
      DEFAULT_RUN_FULL: 'false', MAIN_PUSH_RUN_FULL: '', MAIN_PUSH_RUN_FOCUSED: '',
    })).toEqual({ run_full: 'false', run_focused: 'false' });
    expect(execute({
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
      DEFAULT_RUN_FULL: 'true', MAIN_PUSH_RUN_FULL: '', MAIN_PUSH_RUN_FOCUSED: '',
    })).toEqual({ run_full: 'true', run_focused: 'false' });
  });
});
