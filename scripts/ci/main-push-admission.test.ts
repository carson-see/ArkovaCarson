import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changedFilesForPush, decideMainPush, decideMainPushFromGit } from './main-push-admission.js';
import { focusedTestPlan } from './run-main-t0-validation.js';

describe('protected-main T0 admission', () => {
  it('focuses supported docs, CI policy, and executable test-only pushes', () => {
    expect(decideMainPush(['docs/operations/runbook.md']).runFocused).toBe(true);
    expect(decideMainPush(['.github/workflows/ci.yml', 'scripts/ci/ci-workflow-contract.test.ts']).runFocused).toBe(true);
    expect(decideMainPush(['services/worker/src/api/v1/foo.test.ts']).runFocused).toBe(true);
  });

  it('keeps runtime, deploy, migration, and unsupported T0 changes on the full matrix', () => {
    expect(decideMainPush(['src/components/Foo.tsx']).runFull).toBe(true);
    expect(decideMainPush(['services/worker/src/index.ts']).runFull).toBe(true);
    expect(decideMainPush(['supabase/migrations/9999_x.sql']).runFull).toBe(true);
    expect(decideMainPush(['package-lock.json']).runFull).toBe(true);
    expect(decideMainPush(['.github/workflows/deploy-worker.yml']).runFull).toBe(true);
    expect(decideMainPush(['.github/workflows/edge-deploy.yml']).runFull).toBe(true);
    expect(decideMainPush(['.github/workflows/publish-sdk.yml']).runFull).toBe(true);
    expect(decideMainPush(['tests/rls/new-policy.test.ts']).runFull).toBe(true);
    expect(decideMainPush(['tests/infra/new-seed.test.ts']).runFull).toBe(true);
    expect(decideMainPush(['services/worker/src/jobs/live.integration.test.ts']).runFull).toBe(true);
    expect(decideMainPush(['tests/load/new-load.test.ts']).runFull).toBe(true);
    expect(decideMainPush(['src/tests/rls/new-policy.test.ts']).runFull).toBe(true);
    expect(decideMainPush(['src/tests/migrations/new-schema.test.ts']).runFull).toBe(true);
    expect(decideMainPush(['src/example.spec.ts']).runFull).toBe(true);
    expect(decideMainPush(['services/worker/src/example.spec.ts']).runFull).toBe(true);
    expect(decideMainPush(['services/worker/src/example.test.tsx']).runFull).toBe(true);
    expect(decideMainPush(['services/worker/src/api/admin-invitations.local.test.ts']).runFull).toBe(true);
  });

  it('fails closed for an empty file set', () => {
    expect(decideMainPush([])).toMatchObject({ runFull: true, runFocused: false });
  });

  it('classifies both sides of a rename and routes its deletion to the full matrix', () => {
    const repo = mkdtempSync(join(tmpdir(), 'arkova-main-admission-'));
    const run = (args: string[]) => execFileSync('/usr/bin/git', args, { cwd: repo, encoding: 'utf8' }).trim();
    run(['init', '-q']);
    run(['config', 'user.email', 'ci@example.test']);
    run(['config', 'user.name', 'CI']);
    writeFileSync(join(repo, 'README.md'), 'one\n');
    run(['add', '.']); run(['commit', '-qm', 'base']);
    const before = run(['rev-parse', 'HEAD']);
    run(['mv', 'README.md', 'renamed.txt']);
    run(['commit', '-qam', 'rename']);
    const after = run(['rev-parse', 'HEAD']);
    const oldCwd = process.cwd();
    process.chdir(repo);
    try {
      expect(changedFilesForPush(before, after)).toEqual(['README.md', 'renamed.txt']);
      expect(decideMainPushFromGit(before, after)).toMatchObject({ runFull: true, runFocused: false });
    } finally {
      process.chdir(oldCwd);
    }
  });

  it('rejects malformed or initial-push SHAs', () => {
    expect(() => changedFilesForPush('', 'a'.repeat(40))).toThrow(/missing, malformed/u);
    expect(() => changedFilesForPush('0'.repeat(40), 'a'.repeat(40))).toThrow(/all-zero/u);
  });

  it('runs focused worker tests with worker-local tools and deploy-parity compiles', () => {
    const runner = readFileSync('scripts/ci/run-main-t0-validation.ts', 'utf8');
    expect(runner).toContain("run('npm', ['ci', '--ignore-scripts'], 'services/worker')");
    expect(runner).toContain("run('npm', ['run', 'typecheck'], 'services/worker')");
    expect(runner).toContain("run('npm', ['run', 'build'], 'services/worker')");
    expect(runner).toContain("run('node_modules/.bin/vitest', ['run', ...plan.workerTests.map");
    expect(runner).not.toContain("run('/usr/bin/npm'");
    expect(runner).not.toContain("run('../../node_modules/.bin/vitest'");
  });

  it('retains changed root tests when a mixed push also changes CI policy', () => {
    const plan = focusedTestPlan([
      '.github/workflows/ci.yml',
      'scripts/ci/main-push-admission.test.ts',
      'src/lib/example.test.ts',
    ]);
    expect(plan.runCompleteCiSuite).toBe(true);
    expect(plan.selectedRootTests).toContain('src/lib/example.test.ts');
    expect(plan.selectedRootTests).toContain('scripts/ci/main-push-admission.test.ts');
  });
});
