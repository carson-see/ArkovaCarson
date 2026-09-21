import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changedFilesForPush, decideMainPush, decideMainPushFromGit, resolveSuccessfulMainBaseline } from './main-push-admission.js';
import { focusedTestPlan } from './run-main-t0-validation.js';

describe('protected-main T0 admission', () => {
  function response(runs: unknown[], ok = true, status = 200): Response {
    return { ok, status, json: async () => ({ workflow_runs: runs }) } as Response;
  }

  function successfulRun(sha: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      head_sha: sha,
      head_branch: 'main',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      path: '.github/workflows/ci.yml',
      head_repository: { full_name: 'carson-see/ArkovaCarson' },
      ...overrides,
    };
  }

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

  it('uses the latest successful reachable main run so a canceled runtime push makes its T0 successor full', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'arkova-main-baseline-'));
    const run = (args: string[]) => execFileSync('/usr/bin/git', args, { cwd: repo, encoding: 'utf8' }).trim();
    run(['init', '-q']); run(['config', 'user.email', 'ci@example.test']); run(['config', 'user.name', 'CI']);
    writeFileSync(join(repo, 'README.md'), 'validated\n'); run(['add', '.']); run(['commit', '-qm', 'validated']);
    const validated = run(['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'runtime.ts'), 'runtime\n'); run(['add', '.']); run(['commit', '-qm', 'canceled runtime']);
    const canceledRuntime = run(['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'README.md'), 't0 successor\n'); run(['commit', '-qam', 't0 successor']);
    const after = run(['rev-parse', 'HEAD']);
    const oldCwd = process.cwd(); process.chdir(repo);
    try {
      const baseline = await resolveSuccessfulMainBaseline({
        repository: 'carson-see/ArkovaCarson', after, token: 'test-token',
        fetchImpl: async () => response([successfulRun(validated)]),
      });
      expect(baseline).toBe(validated);
      expect(decideMainPushFromGit(baseline, after)).toMatchObject({ runFull: true, runFocused: false });
      expect(decideMainPushFromGit(canceledRuntime, after)).toMatchObject({ runFull: false, runFocused: true });
    } finally { process.chdir(oldCwd); }
  });

  it('keeps a genuine T0 push focused after the previous main commit completed CI', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'arkova-main-success-'));
    const run = (args: string[]) => execFileSync('/usr/bin/git', args, { cwd: repo, encoding: 'utf8' }).trim();
    run(['init', '-q']); run(['config', 'user.email', 'ci@example.test']); run(['config', 'user.name', 'CI']);
    writeFileSync(join(repo, 'README.md'), 'validated\n'); run(['add', '.']); run(['commit', '-qm', 'validated']);
    const validated = run(['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'README.md'), 'focused\n'); run(['commit', '-qam', 'focused']);
    const after = run(['rev-parse', 'HEAD']);
    const oldCwd = process.cwd(); process.chdir(repo);
    try {
      const baseline = await resolveSuccessfulMainBaseline({ repository: 'carson-see/ArkovaCarson', after, token: 'x', fetchImpl: async () => response([successfulRun(validated)]) });
      expect(decideMainPushFromGit(baseline, after)).toMatchObject({ runFull: false, runFocused: true });
    } finally { process.chdir(oldCwd); }
  });

  it('rejects malformed API data, wrong-repository runs, non-ancestors, and API failures', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'arkova-main-invalid-baseline-'));
    const run = (args: string[]) => execFileSync('/usr/bin/git', args, { cwd: repo, encoding: 'utf8' }).trim();
    run(['init', '-q']); run(['config', 'user.email', 'ci@example.test']); run(['config', 'user.name', 'CI']);
    writeFileSync(join(repo, 'README.md'), 'main\n'); run(['add', '.']); run(['commit', '-qm', 'main']);
    const after = run(['rev-parse', 'HEAD']);
    run(['checkout', '-qb', 'other', 'HEAD^0']);
    writeFileSync(join(repo, 'other.txt'), 'unreachable\n'); run(['add', '.']); run(['commit', '-qm', 'other']);
    const nonAncestor = run(['rev-parse', 'HEAD']);
    run(['checkout', '-q', '--detach', after]);
    const oldCwd = process.cwd(); process.chdir(repo);
    try {
    await expect(resolveSuccessfulMainBaseline({ repository: 'carson-see/ArkovaCarson', after, token: 'x', fetchImpl: async () => response([], false, 500) })).rejects.toThrow(/HTTP 500/u);
    await expect(resolveSuccessfulMainBaseline({ repository: 'carson-see/ArkovaCarson', after, token: 'x', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ nope: [] }) }) as Response })).rejects.toThrow(/malformed JSON/u);
    await expect(resolveSuccessfulMainBaseline({ repository: 'carson-see/ArkovaCarson', after, token: 'x', fetchImpl: async () => response([successfulRun('b'.repeat(40), { head_repository: { full_name: 'attacker/fork' } })]) })).rejects.toThrow(/no successful reachable/u);
      await expect(resolveSuccessfulMainBaseline({ repository: 'carson-see/ArkovaCarson', after, token: 'x', fetchImpl: async () => response([successfulRun(nonAncestor)]) })).rejects.toThrow(/no successful reachable/u);
      await expect(resolveSuccessfulMainBaseline({ repository: 'carson-see/ArkovaCarson', after, token: 'x', fetchImpl: async () => response([successfulRun(after, { head_sha: nonAncestor, path: '.github/workflows/deploy-worker.yml' })]) })).rejects.toThrow(/no successful reachable/u);
    } finally { process.chdir(oldCwd); }
  });

  it('bounds API wall time and refuses credential-bearing redirects', async () => {
    let observed: RequestInit | undefined;
    await expect(resolveSuccessfulMainBaseline({
      repository: 'carson-see/ArkovaCarson', after: 'a'.repeat(40), token: 'secret-token',
      fetchImpl: async (_url, init) => { observed = init; return response([]); },
    })).rejects.toThrow(/no successful reachable/u);
    expect(observed?.redirect).toBe('error');
    expect(observed?.signal).toBeInstanceOf(AbortSignal);
    expect(observed?.signal?.aborted).toBe(false);
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

  it('grants only read access and passes the resolved baseline to focused validation', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(workflow).toContain('actions: read');
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('GITHUB_TOKEN: ${{ github.token }}');
    expect(workflow).toContain('baseline_sha: ${{ steps.main_push.outputs.baseline_sha }}');
    expect(workflow).toContain('PUSH_BEFORE: ${{ needs.admission.outputs.baseline_sha }}');
    expect(workflow).not.toContain('PUSH_BEFORE: ${{ github.event.before }}');
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
