/**
 * SCRUM-1005 (DEP-15) — regression tests for the dependency pinning
 * enforcement script.
 *
 * The script under test scans tracked package.json files in real repos and
 * falls back to filesystem discovery for /tmp fixtures. We spawn it as a
 * child process against synthesized package.json trees, then assert on exit
 * code + output.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { listPackageJsons, resolveRepoRoot } from './check-dep-pinning.js';

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
  });

  beforeEach(() => {
    rmSync(tmp, { recursive: true, force: true });
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

  it('exits 0 when all discovered deps are pinned exactly', () => {
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
    mkdirSync(join(tmp, 'packages', 'sdk'), { recursive: true });
    writeFileSync(join(tmp, 'packages', 'sdk', 'package.json'), JSON.stringify({
      name: 'fixture-sdk',
      peerDependencies: { react: '18.2.0' },
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

  it('exits 1 on caret ranges in peerDependencies', () => {
    seedFixture({
      name: 'fixture-root',
      peerDependencies: { react: '^18.2.0' },
    });
    const r = runScript(tmp);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('react');
    expect(r.stderr).toContain('peerDependencies');
    expect(r.stderr).toContain('^18.2.0');
  });

  it('finds nested package.json files beyond the historical fixed paths', () => {
    seedFixture({
      name: 'fixture-root',
      dependencies: { lodash: '4.17.21' },
    });
    mkdirSync(join(tmp, 'integrations', 'zapier'), { recursive: true });
    writeFileSync(join(tmp, 'integrations', 'zapier', 'package.json'), JSON.stringify({
      name: 'fixture-zapier',
      dependencies: { 'zapier-platform-core': '^15.0.0' },
    }));
    const r = runScript(tmp);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('integrations/zapier/package.json');
    expect(r.stderr).toContain('zapier-platform-core');
  });

  it('does not scan package.json files under node_modules in filesystem fallback mode', () => {
    seedFixture({
      name: 'fixture-root',
      dependencies: { lodash: '4.17.21' },
    });
    mkdirSync(join(tmp, 'node_modules', 'bad-package'), { recursive: true });
    writeFileSync(join(tmp, 'node_modules', 'bad-package', 'package.json'), JSON.stringify({
      name: 'bad-package',
      dependencies: { 'range-leak': '^1.0.0' },
    }));
    const r = runScript(tmp);
    expect(r.status).toBe(0);
  });

  it('honours the dep-range-intentional override label across all discovered package.json files', () => {
    seedFixture({
      name: 'fixture-root',
      dependencies: { 'root-range': '^1.0.0' },
    });
    writeFileSync(join(tmp, 'services', 'worker', 'package.json'), JSON.stringify({
      name: 'fixture-worker',
      dependencies: { 'worker-range': '~2.0.0' },
    }));
    mkdirSync(join(tmp, 'packages', 'embed'), { recursive: true });
    writeFileSync(join(tmp, 'packages', 'embed', 'package.json'), JSON.stringify({
      name: 'fixture-embed',
      peerDependencies: { 'embed-range': '^3.0.0' },
    }));
    const r = runScript(tmp, { PR_LABELS: 'dep-range-intentional' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PR labeled');
    expect(r.stdout).toContain('root-range');
    expect(r.stdout).toContain('worker-range');
    expect(r.stdout).toContain('embed-range');
  });

  it('does not require historical optional paths to exist', () => {
    seedFixture({
      name: 'fixture-root',
      dependencies: { lodash: '4.17.21' },
    });
    rmSync(join(tmp, 'services', 'worker', 'package.json'), { force: true });
    rmSync(join(tmp, 'services', 'edge', 'package.json'), { force: true });
    const r = runScript(tmp);
    expect(r.status).toBe(0);
  });

  it('lists package.json files using the filesystem fallback outside git repos', () => {
    seedFixture({
      name: 'fixture-root',
      dependencies: {},
    });
    mkdirSync(join(tmp, 'packages', 'sdk'), { recursive: true });
    writeFileSync(join(tmp, 'packages', 'sdk', 'package.json'), JSON.stringify({
      name: 'fixture-sdk',
    }));
    expect(listPackageJsons(tmp)).toContain('packages/sdk/package.json');
  });
});

/**
 * SonarCloud security hotspot regression — DEP_PINNING_REPO_ROOT must not
 * let a malicious caller read /etc/, ~/.ssh/, etc.
 *
 * The script-spawn tests above prove the happy path (a valid /tmp fixture).
 * These unit tests prove the validator rejects everything else.
 */
describe('resolveRepoRoot security validation', () => {
  let validTmp: string;
  const originalEnv = process.env.DEP_PINNING_REPO_ROOT;

  beforeAll(() => {
    validTmp = mkdtempSync(join(tmpdir(), 'dep-pinning-validate-'));
    writeFileSync(
      join(validTmp, 'package.json'),
      JSON.stringify({ name: 'fixture' }),
    );
  });

  afterAll(() => {
    rmSync(validTmp, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.DEP_PINNING_REPO_ROOT;
    } else {
      process.env.DEP_PINNING_REPO_ROOT = originalEnv;
    }
  });

  beforeEach(() => {
    delete process.env.DEP_PINNING_REPO_ROOT;
  });

  afterEach(() => {
    delete process.env.DEP_PINNING_REPO_ROOT;
  });

  it('returns the fallback (script repo root) when the env var is unset', () => {
    const r = resolveRepoRoot();
    // The fallback resolves to a real directory containing this script.
    expect(r).toMatch(/[\\/]/);
    expect(r.length).toBeGreaterThan(0);
  });

  it('accepts a valid /tmp path that contains a package.json', () => {
    process.env.DEP_PINNING_REPO_ROOT = validTmp;
    const r = resolveRepoRoot();
    // The validator may resolve symlinks (/tmp -> /private/tmp on macOS),
    // so just compare basenames.
    expect(r.endsWith(validTmp.split('/').pop() ?? '')).toBe(true);
  });

  it('rejects a path outside repo root and /tmp (e.g. user home)', () => {
    // homedir() is neither inside the repo nor inside /tmp.
    process.env.DEP_PINNING_REPO_ROOT = homedir();
    expect(() => resolveRepoRoot()).toThrow(/outside.*repo root.*temp dir|refusing for safety/i);
  });

  it('rejects /etc — a classic path-traversal target', () => {
    process.env.DEP_PINNING_REPO_ROOT = '/etc';
    expect(() => resolveRepoRoot()).toThrow(/outside.*repo root.*temp dir|refusing for safety/i);
  });

  it('rejects a /tmp path with no package.json', () => {
    const noPkg = mkdtempSync(join(tmpdir(), 'dep-pinning-no-pkg-'));
    try {
      process.env.DEP_PINNING_REPO_ROOT = noPkg;
      expect(() => resolveRepoRoot()).toThrow(/no package\.json/);
    } finally {
      rmSync(noPkg, { recursive: true, force: true });
    }
  });

  it('rejects a non-existent /tmp path', () => {
    process.env.DEP_PINNING_REPO_ROOT = join(tmpdir(), 'does-not-exist-' + Date.now());
    expect(() => resolveRepoRoot()).toThrow();
  });

  it('rejects a path that traverses out of /tmp via .. segments', () => {
    // path.resolve will normalize this away and land in /etc, which is outside the allowlist.
    process.env.DEP_PINNING_REPO_ROOT = join(tmpdir(), '..', '..', 'etc');
    expect(() => resolveRepoRoot()).toThrow(/outside.*repo root.*temp dir|refusing for safety/i);
  });
});
