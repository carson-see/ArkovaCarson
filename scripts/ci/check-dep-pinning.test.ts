/**
 * SCRUM-1005 (DEP-15) — regression tests for the dependency pinning
 * enforcement script.
 *
 * The script under test scans package.json files at fixed relative paths
 * from the repo root, so we can't easily inject mock files. Instead we
 * spawn the script as a child process with a controlled cwd that
 * contains a synthesized package.json fixture, then assert on exit code
 * + stderr.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = resolve(import.meta.dirname, 'check-dep-pinning.ts');

function runScript(repoRoot: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync('npx', ['tsx', SCRIPT], {
    env: { ...process.env, DEP_PINNING_REPO_ROOT: repoRoot, PR_LABELS: '', ...env },
    encoding: 'utf8',
  });
}

describe('check-dep-pinning (SCRUM-1005)', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dep-pinning-test-'));
    mkdirSync(join(tmp, 'services', 'worker'), { recursive: true });
    mkdirSync(join(tmp, 'services', 'edge'), { recursive: true });
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Write a fixture root package.json plus empty worker/edge stubs. */
  function seedFixture(rootPkg: object) {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify(rootPkg));
    writeFileSync(
      join(tmp, 'services', 'worker', 'package.json'),
      JSON.stringify({ name: 'fixture-worker', dependencies: {} }),
    );
    writeFileSync(
      join(tmp, 'services', 'edge', 'package.json'),
      JSON.stringify({ name: 'fixture-edge', dependencies: {} }),
    );
  }

  it('exits 0 when all production deps are pinned exactly', () => {
    seedFixture({
      name: 'fixture-root',
      dependencies: { lodash: '4.17.21' },
      devDependencies: { vitest: '4.1.5' },
    });
    // Override worker stub with a real pinned dep to exercise that path too.
    writeFileSync(join(tmp, 'services', 'worker', 'package.json'), JSON.stringify({
      name: 'fixture-worker',
      dependencies: { axios: '1.15.0' },
    }));
    const r = runScript(tmp);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('All dependency versions are pinned');
  });

  it('exits 1 with violations listed when caret ranges leak in', () => {
    seedFixture({
      name: 'fixture-root',
      dependencies: { 'sneaky-pkg': '^2.0.0' },
    });
    const r = runScript(tmp);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('sneaky-pkg');
    expect(r.stderr).toContain('^2.0.0');
    expect(r.stderr).toContain('SCRUM-1005');
  });

  it('exits 1 on tilde ranges in devDependencies', () => {
    seedFixture({
      name: 'fixture-root',
      devDependencies: { 'fluky-pkg': '~3.4.0' },
    });
    const r = runScript(tmp);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('fluky-pkg');
    expect(r.stderr).toContain('~3.4.0');
  });

  it('honours the dep-range-intentional override label across all 3 package.json paths', () => {
    seedFixture({
      name: 'fixture-root',
      dependencies: { 'root-range': '^1.0.0' },
    });
    // Cover all three scanned paths so a future regression that scopes the
    // override to root only fails this test loudly.
    writeFileSync(join(tmp, 'services', 'worker', 'package.json'), JSON.stringify({
      name: 'fixture-worker',
      dependencies: { 'worker-range': '~2.0.0' },
    }));
    writeFileSync(join(tmp, 'services', 'edge', 'package.json'), JSON.stringify({
      name: 'fixture-edge',
      devDependencies: { 'edge-range': '^3.0.0' },
    }));
    const r = runScript(tmp, { PR_LABELS: 'dep-range-intentional' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PR labeled');
    expect(r.stdout).toContain('root-range');
    expect(r.stdout).toContain('worker-range');
    expect(r.stdout).toContain('edge-range');
  });

  it('skips package.json files that do not exist (e.g. services/edge missing)', () => {
    seedFixture({
      name: 'fixture-root',
      dependencies: { lodash: '4.17.21' },
    });
    rmSync(join(tmp, 'services', 'edge', 'package.json'), { force: true });
    const r = runScript(tmp);
    expect(r.status).toBe(0);
  });
});
