/**
 * SCRUM-1258 — regression tests for the worker env-adhoc lint.
 *
 * Spawns the script with WORKER_ENV_ADHOC_REPO_ROOT pointed at a temp
 * git repo so we exercise the live `git ls-files` path without scanning
 * the real worker source tree.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = resolve(import.meta.dirname, 'check-worker-env-adhoc.ts');

function run(repoRoot: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync('npx', ['tsx', SCRIPT], {
    env: { ...process.env, WORKER_ENV_ADHOC_REPO_ROOT: repoRoot, PR_LABELS: '', ...env },
    encoding: 'utf8',
  });
}

function gitInit(repo: string) {
  spawnSync('git', ['init', '-q'], { cwd: repo });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: repo });
  gitCommit(repo, 'init');
}

function gitCommit(repo: string, message: string) {
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-q', '-m', message], { cwd: repo });
}

function seedTree(repo: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(repo, path);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
}

describe('check-worker-env-adhoc (SCRUM-1258)', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'env-adhoc-test-'));
    mkdirSync(join(tmp, 'scripts', 'ci', 'snapshots'), { recursive: true });
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('exits 0 when scanned files match the baseline exactly', () => {
    seedTree(tmp, {
      'services/worker/src/foo.ts': 'const x = process.env.FOO;',
      'scripts/ci/snapshots/worker-env-adhoc-baseline.json': JSON.stringify({
        identifiers: ['FOO'],
        dynamic: [],
      }),
    });
    gitInit(tmp);
    const r = run(tmp);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No new ad-hoc');
  });

  it('exits 1 when a NEW ad-hoc read appears outside the baseline', () => {
    seedTree(tmp, {
      'services/worker/src/foo.ts': 'const x = process.env.FOO;\nconst y = process.env.NEW_VAR;',
      'scripts/ci/snapshots/worker-env-adhoc-baseline.json': JSON.stringify({
        identifiers: ['FOO'],
        dynamic: [],
      }),
    });
    gitCommit(tmp, 'add new var');
    const r = run(tmp);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('NEW_VAR');
    expect(r.stderr).toContain('SCRUM-1258');
  });

  it('honours the worker-env-adhoc-baseline-update override label', () => {
    const r = run(tmp, { PR_LABELS: 'worker-env-adhoc-baseline-update' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PR labeled');
  });

  it('skips config.ts (allowlisted as the canonical absorber)', () => {
    seedTree(tmp, {
      'services/worker/src/config.ts':
        'const a = process.env.ANYTHING; const b = process.env.SHOULD_BE_IGNORED;',
      'services/worker/src/foo.ts': 'const x = process.env.FOO;',
      'scripts/ci/snapshots/worker-env-adhoc-baseline.json': JSON.stringify({
        identifiers: ['FOO'],
        dynamic: [],
      }),
    });
    gitCommit(tmp, 'add config + foo');
    const r = run(tmp);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No new ad-hoc');
  });

  it('skips test files (.test.ts)', () => {
    seedTree(tmp, {
      'services/worker/src/foo.test.ts':
        'process.env.TEST_ONLY_VAR = "x"; const z = process.env.ANOTHER;',
    });
    gitCommit(tmp, 'add test');
    const r = run(tmp);
    expect(r.status).toBe(0);
  });

  it('catches bracket-literal access (process.env["FOO"])', () => {
    seedTree(tmp, {
      'services/worker/src/bracket.ts':
        'const a = process.env["BRACKET_LITERAL"]; const b = process.env[\'OTHER\'];',
      'scripts/ci/snapshots/worker-env-adhoc-baseline.json': JSON.stringify({
        identifiers: ['FOO'],
        dynamic: [],
      }),
    });
    gitCommit(tmp, 'add bracket access');
    const r = run(tmp);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('BRACKET_LITERAL');
    expect(r.stderr).toContain('OTHER');
  });

  it('catches dynamic bracket access (process.env[someVar])', () => {
    seedTree(tmp, {
      'services/worker/src/dynamic.ts':
        'const k = "X"; const v = process.env[k]; for (const flag of FLAGS) process.env[flag];',
      'scripts/ci/snapshots/worker-env-adhoc-baseline.json': JSON.stringify({
        identifiers: ['FOO'],
        dynamic: [],
      }),
    });
    gitCommit(tmp, 'add dynamic bracket');
    const r = run(tmp);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('dynamic process.env');
    expect(r.stderr).toContain('process.env[k]');
  });

  it('honours dynamic-bracket entries in the baseline', () => {
    // Hermetic: this test rebuilds the tree so leftover files from prior
    // tests don't smuggle unbaselined identifiers in.
    rmSync(join(tmp, 'services'), { recursive: true, force: true });
    seedTree(tmp, {
      'services/worker/src/known.ts': 'const v = process.env[someVar];',
      'scripts/ci/snapshots/worker-env-adhoc-baseline.json': JSON.stringify({
        identifiers: [],
        dynamic: ['services/worker/src/known.ts::process.env[someVar]'],
      }),
    });
    gitCommit(tmp, 'baseline known dynamic');
    const r = run(tmp);
    expect(r.status).toBe(0);
  });
});
