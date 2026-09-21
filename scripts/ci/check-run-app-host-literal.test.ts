import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  RUN_APP_HOST_RE,
  RUN_APP_ALLOWLIST,
  findRunAppViolations,
  checkRunAppHostLiteral,
} from './check-run-app-host-literal';

describe('RUN_APP_HOST_RE', () => {
  it('matches the classic multi-label Cloud Run revision host, in full', () => {
    const text = 'fetch("https://arkova-worker-270018525501.us-central1.run.app/api/v1")';
    const matches = [...text.matchAll(RUN_APP_HOST_RE)].map((m) => m[0]);
    expect(matches).toEqual(['arkova-worker-270018525501.us-central1.run.app']);
  });

  it('matches the newer <hash>-<region>.a.run.app format, in full — not truncated to "a.run.app"', () => {
    const text = 'const url = "https://abc123xyz-uc.a.run.app/health";';
    const matches = [...text.matchAll(RUN_APP_HOST_RE)].map((m) => m[0]);
    expect(matches).toEqual(['abc123xyz-uc.a.run.app']);
  });

  it('matches a synthetic test placeholder host in full', () => {
    const text = "const host = 'pr-1461---arkova-worker-staging-abc.run.app';";
    const matches = [...text.matchAll(RUN_APP_HOST_RE)].map((m) => m[0]);
    expect(matches).toEqual(['pr-1461---arkova-worker-staging-abc.run.app']);
  });

  it('does not match an unrelated .app domain or a bare "run.app" with no host label', () => {
    expect([...'https://arkova.app/verify'.matchAll(RUN_APP_HOST_RE)]).toHaveLength(0);
  });
});

describe('RUN_APP_ALLOWLIST', () => {
  it('every entry has a non-empty reason', () => {
    for (const entry of RUN_APP_ALLOWLIST) {
      expect(entry.reason.length, `${entry.path} has an empty reason`).toBeGreaterThan(0);
    }
  });

  it('has no duplicate path entries', () => {
    const paths = RUN_APP_ALLOWLIST.map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('findRunAppViolations — synthetic fixture repo', () => {
  let repo: string;

  beforeAll(() => {
    // A real, minimal git repo (the scanner shells out to `git ls-files`,
    // so it needs one) with one violating file and one allowlisted file,
    // proving the allowlist actually suppresses what it names and nothing
    // else.
    repo = mkdtempSync(join(tmpdir(), 'run-app-guard-fixture-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });

    writeFileSync(
      join(repo, 'violating.ts'),
      "export const BASE = 'https://some-service-abc123.us-central1.run.app';\n",
    );
    mkdirSync(join(repo, 'CLAUDE_DIR'), { recursive: true });
    writeFileSync(
      join(repo, 'CLAUDE_DIR', 'ok.md'),
      'The raw host is some-service-abc123.us-central1.run.app.\n',
    );
    writeFileSync(join(repo, 'clean.ts'), "export const BASE = 'https://api.arkova.ai';\n");
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('flags a file with an un-allowlisted *.run.app literal', () => {
    const violations = findRunAppViolations(repo);
    const files = violations.map((v) => v.file);
    expect(files).toContain('violating.ts');
    expect(files).not.toContain('clean.ts');
  });

  it('checkRunAppHostLiteral returns 1 (fail) against the fixture repo', () => {
    expect(checkRunAppHostLiteral(repo)).toBe(1);
  });
});

describe('checkRunAppHostLiteral — the real repo', () => {
  // The actual CI gate assertion: at HEAD, every *.run.app literal anywhere
  // in the git-tracked, text-like tree is either gone or explicitly
  // allowlisted with a reason. This is what makes the guard load-bearing —
  // everything above is unit coverage of the mechanism.
  it('returns 0 (pass) — no un-allowlisted *.run.app literal in the repo', () => {
    expect(checkRunAppHostLiteral()).toBe(0);
  }, 15_000);
});
