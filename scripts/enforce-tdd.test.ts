import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), 'enforce-tdd.sh');
const repos: string[] = [];

function git(repo: string, ...args: string[]): string {
  return execFileSync('/usr/bin/git', args, {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
}

function createRepository(): { repo: string; baseSha: string } {
  const repo = mkdtempSync(join(tmpdir(), 'enforce-tdd-s33-'));
  repos.push(repo);

  git(repo, 'init', '--quiet', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'TDD Gate Test');
  git(repo, 'config', 'user.email', 'tdd-gate-test@arkova.invalid');

  mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(
    join(repo, 'scripts/enforce-tdd.sh'),
    readFileSync(SCRIPT_SOURCE, 'utf8'),
  );
  writeFileSync(join(repo, 'README.md'), 'baseline\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'baseline');

  return { repo, baseSha: git(repo, 'rev-parse', 'HEAD') };
}

function addSourceAndRun(path: string): ReturnType<typeof spawnSync> {
  const { repo, baseSha } = createRepository();
  const absolutePath = join(repo, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, 'export const fixture = true;\n');
  git(repo, 'add', path);
  git(repo, 'commit', '--quiet', '-m', `add ${path}`);

  return spawnSync('/bin/bash', ['scripts/enforce-tdd.sh', '--diff', baseSha], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, SKIP_TDD_CHECK: '' },
  });
}

afterEach(() => {
  while (repos.length > 0) {
    rmSync(repos.pop()!, { recursive: true, force: true });
  }
});

describe('enforce-tdd Sprint 3.3 frozen-corpus carve-out', () => {
  it.each([
    'services/worker/src/ai/eval/golden-dataset-s33-au-ke-heldout.ts',
    'services/worker/src/ai/eval/golden-dataset-s33-licensing-heldout.ts',
    'services/worker/src/ai/eval/golden-dataset-s33-ood-negatives.ts',
  ])('treats exact offline corpus data as non-production: %s', (path) => {
    const result = addSourceAndRun(path);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('TDD check passed — no production code changes');
  });

  it.each([
    'services/worker/src/ai/eval/golden-dataset-s33-unratified.ts',
    'services/worker/src/jobs/ordinary-worker-source.ts',
  ])('keeps non-allowlisted worker source under TDD enforcement: %s', (path) => {
    const result = addSourceAndRun(path);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('TDD ENFORCEMENT FAILED');
    expect(result.stdout).toContain(path);
  });
});
