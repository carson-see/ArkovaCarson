import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '..', '..');
const SCRIPT = resolve(REPO, 'scripts/release/check-python-publish-admission.py');
const WORKFLOW = resolve(REPO, '.github/workflows/publish-python-sdk.yml');
const parsedVersion = spawnSync('python3', [
  '-c',
  'import sys,tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["project"]["version"])',
  resolve(REPO, 'packages/arkova-py/pyproject.toml'),
], { encoding: 'utf8', timeout: 3_000 });
if (parsedVersion.status !== 0) throw new Error('Python 3.11+ tomllib is required for this test');
const VERSION = parsedVersion.stdout.trim();

function runAdmission(eventName: string, ref: string, options: { output?: boolean; manifest?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'arkova-python-admission-'));
  try {
    const script = options.manifest === undefined ? SCRIPT : join(dir, 'scripts/release/check-python-publish-admission.py');
    if (options.manifest !== undefined) {
      mkdirSync(dirname(script), { recursive: true });
      mkdirSync(join(dir, 'packages/arkova-py'), { recursive: true });
      copyFileSync(SCRIPT, script);
      writeFileSync(join(dir, 'packages/arkova-py/pyproject.toml'), options.manifest);
    }
    const outputPath = join(dir, 'github-output');
    const result = spawnSync('python3', [script], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 3_000,
      env: {
        PATH: process.env.PATH ?? '',
        GITHUB_EVENT_NAME: eventName,
        GITHUB_REF: ref,
        ...(options.output === false ? {} : { GITHUB_OUTPUT: outputPath }),
      },
    });
    let output = '';
    try { output = readFileSync(outputPath, 'utf8'); } catch { /* denial writes nothing */ }
    return { status: result.status, output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Python SDK publication admission', () => {
  it('makes dispatch build-only even at the matching tag', () => {
    expect(runAdmission('workflow_dispatch', 'refs/heads/main')).toEqual({ status: 0, output: 'publish=false\n' });
    expect(runAdmission('workflow_dispatch', `refs/tags/arkova-py-v${VERSION}`)).toEqual({ status: 0, output: 'publish=false\n' });
  });

  it('admits only a push of the exact checked-out manifest version', () => {
    expect(runAdmission('push', `refs/tags/arkova-py-v${VERSION}`)).toEqual({ status: 0, output: 'publish=true\n' });
    for (const ref of ['refs/heads/main', 'refs/tags/arkova-py-v0.0.0', `refs/tags/other-v${VERSION}`]) {
      const denied = runAdmission('push', ref);
      expect(denied.status).not.toBe(0);
      expect(denied.output).toBe('');
    }
    expect(runAdmission('schedule', `refs/tags/arkova-py-v${VERSION}`).status).not.toBe(0);
  });

  it('fails closed for missing output or missing manifest version', () => {
    expect(runAdmission('push', `refs/tags/arkova-py-v${VERSION}`, { output: false }).status).not.toBe(0);
    const missing = runAdmission('push', `refs/tags/arkova-py-v${VERSION}`, { manifest: '[project]\nname = "arkova"\n' });
    expect(missing.status).not.toBe(0);
    expect(missing.output).toBe('');
    const blank = runAdmission('workflow_dispatch', 'refs/heads/main', { manifest: '[project]\nversion = " "\n' });
    expect(blank.status).not.toBe(0);
    expect(blank.output).toBe('');
  });

  it('uses the admission output to guard the existing provenance publisher', () => {
    const workflow = load(readFileSync(WORKFLOW, 'utf8')) as {
      on: Record<string, unknown>;
      permissions: Record<string, string>;
      jobs: { publish: { steps: Array<Record<string, unknown>> } };
    };
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(workflow.on.push).toEqual({ tags: ['arkova-py-v*'] });
    const steps = workflow.jobs.publish.steps;
    const admissionIndex = steps.findIndex(step => step.id === 'admission');
    const installIndex = steps.findIndex(step => step.name === 'Install locked development environment');
    const publish = steps.find(step => step.name === 'Publish to PyPI');
    expect(admissionIndex).toBeGreaterThan(0);
    expect(admissionIndex).toBeLessThan(installIndex);
    expect(steps[admissionIndex].run).toBe('python ../../scripts/release/check-python-publish-admission.py');
    expect(publish?.if).toBe("steps.admission.outputs.publish == 'true'");
    expect(String(publish?.uses)).toContain('pypa/gh-action-pypi-publish@');
    expect(publish?.with).toEqual({ 'packages-dir': 'packages/arkova-py/dist' });
    expect(workflow.permissions['id-token']).toBe('write');
  });
});
