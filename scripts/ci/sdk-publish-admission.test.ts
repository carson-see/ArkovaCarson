import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '..', '..');
const SCRIPT = resolve(REPO, 'scripts/release/check-sdk-publish-admission.mjs');
const WORKFLOW = resolve(REPO, '.github/workflows/publish-sdk.yml');
const VERSION = JSON.parse(readFileSync(resolve(REPO, 'packages/sdk/package.json'), 'utf8')).version as string;

function runAdmission(eventName: string, ref: string, includeOutput = true) {
  const dir = mkdtempSync(join(tmpdir(), 'arkova-sdk-admission-'));
  try {
    const outputPath = join(dir, 'github-output');
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 3_000,
      env: {
        PATH: process.env.PATH ?? '',
        GITHUB_EVENT_NAME: eventName,
        GITHUB_REF: ref,
        ...(includeOutput ? { GITHUB_OUTPUT: outputPath } : {}),
        NODE_AUTH_TOKEN: 'synthetic-credential-must-not-appear',
      },
    });
    let output = '';
    try { output = readFileSync(outputPath, 'utf8'); } catch { /* a denial has no output */ }
    expect(`${result.stdout}${result.stderr}${output}`).not.toContain('synthetic-credential-must-not-appear');
    return { status: result.status, output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('SDK publication admission', () => {
  it('makes manual dispatch build-only, including dispatch at a tag', () => {
    expect(runAdmission('workflow_dispatch', 'refs/heads/main')).toEqual({ status: 0, output: 'publish=false\n' });
    expect(runAdmission('workflow_dispatch', `refs/tags/sdk-v${VERSION}`)).toEqual({ status: 0, output: 'publish=false\n' });
  });

  it('admits only a tag matching the checked-out package version', () => {
    expect(runAdmission('push', `refs/tags/sdk-v${VERSION}`)).toEqual({ status: 0, output: 'publish=true\n' });
    for (const ref of ['refs/heads/main', 'refs/tags/sdk-v0.0.0', `refs/tags/other-v${VERSION}`]) {
      const denied = runAdmission('push', ref);
      expect(denied.status).not.toBe(0);
      expect(denied.output).toBe('');
    }
  });

  it('fails closed without an Actions output path', () => {
    const denied = runAdmission('push', `refs/tags/sdk-v${VERSION}`, false);
    expect(denied.status).not.toBe(0);
    expect(denied.output).toBe('');
  });

  it('keeps the npm token on the guarded publish step alone', () => {
    const workflow = load(readFileSync(WORKFLOW, 'utf8')) as {
      on: Record<string, unknown>;
      jobs: { publish: { env?: Record<string, string>; steps: Array<Record<string, unknown>> } };
    };
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(workflow.on.push).toEqual({ tags: ['sdk-v*'] });
    const job = workflow.jobs.publish;
    const admission = job.steps.find(step => step.id === 'admission');
    const publish = job.steps.find(step => step.name === 'Publish');
    expect(admission?.run).toBe('node ../../scripts/release/check-sdk-publish-admission.mjs');
    expect(publish?.if).toBe("steps.admission.outputs.publish == 'true'");
    expect(publish?.env).toEqual({ NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}' });
    expect(String(publish?.run)).toContain('npm publish --provenance --access public');
    expect(job.env ?? {}).not.toHaveProperty('NODE_AUTH_TOKEN');
    for (const step of job.steps.filter(step => step !== publish)) {
      expect(JSON.stringify(step)).not.toContain('secrets.NPM_TOKEN');
      expect(JSON.stringify(step)).not.toContain('NODE_AUTH_TOKEN');
    }
  });
});
