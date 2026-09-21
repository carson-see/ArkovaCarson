import { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  RUN_APP_ALLOWLIST,
  findRunAppHostLiterals,
  findRunAppViolations,
  checkRunAppHostLiteral,
} from './check-run-app-host-literal';

describe('findRunAppHostLiterals', () => {
  it('matches the classic multi-label Cloud Run revision host, in full', () => {
    const text = 'fetch("https://arkova-worker-270018525501.us-central1.run.app/api/v1")';
    expect(findRunAppHostLiterals(text)).toEqual(['arkova-worker-270018525501.us-central1.run.app']);
  });

  it('matches the newer <hash>-<region>.a.run.app format, in full — not truncated to "a.run.app"', () => {
    const text = 'const url = "https://abc123xyz-uc.a.run.app/health";';
    expect(findRunAppHostLiterals(text)).toEqual(['abc123xyz-uc.a.run.app']);
  });

  it('matches a synthetic test placeholder host in full', () => {
    const text = "const host = 'pr-1461---arkova-worker-staging-abc.run.app';";
    expect(findRunAppHostLiterals(text)).toEqual(['pr-1461---arkova-worker-staging-abc.run.app']);
  });

  it('does not match an unrelated .app domain or a bare "run.app" with no host label', () => {
    expect(findRunAppHostLiterals('https://arkova.app/verify')).toHaveLength(0);
  });

  it('does not match a bare "run.app" phrase in prose (no preceding label + dot)', () => {
    expect(findRunAppHostLiterals('a request against the bare run.app host never carries it')).toHaveLength(0);
  });

  it('does not match "run.app" embedded inside a regex/code literal with no real label before it', () => {
    // Real example from scripts/ci/load-harness-artifact.ts — the characters
    // immediately before "run.app" are regex syntax (`\`, `]`, `+`), not a
    // hostname label, so this must not be treated as a live host literal.
    const text = String.raw`!/^https:\/\/[^\s]+\.run\.app\/?$/i.test(value.apiBase)`;
    expect(findRunAppHostLiterals(text)).toHaveLength(0);
  });

  it('finds multiple distinct host literals in one file, each in full', () => {
    const text = [
      'const a = "https://svc-one-abc.us-central1.run.app";',
      'const b = "https://svc-two-def.us-central1.run.app";',
    ].join('\n');
    expect(findRunAppHostLiterals(text)).toEqual([
      'svc-one-abc.us-central1.run.app',
      'svc-two-def.us-central1.run.app',
    ]);
  });

  // 2026-09-21 independent self-audit (SCRUM-3888): the original
  // implementation was a single backtracking regex,
  // /(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+run\.app/gi — a textbook
  // nested-quantifier ReDoS shape (the inner optional group is ambiguous
  // with the outer `+` whenever no terminating ".run.app" is found). Measured
  // against a 200KB adversarial line of plain repeated characters with no
  // match possible, it took ~30 SECONDS to return. A naive single-quantifier
  // rewrite was also measured and found quadratic (~25-40s) on the same
  // input for the same underlying reason (backtracking retry at every start
  // offset). The fix replaces regex backtracking entirely with two linear
  // passes (see the docblock in check-run-app-host-literal.ts) — this test
  // is the regression guard for that fix, run against several adversarial
  // shapes, each of which must complete in well under a second.
  describe('ReDoS resistance — 200KB adversarial input', () => {
    const CASES: Array<[string, string]> = [
      ['long run of alnum chars, no dots, no match possible', 'a'.repeat(200_000)],
      ['long run of dot-and-alnum labels, no run.app suffix', 'a1b2c3-d4.'.repeat(20_000)],
      [
        'near-miss: valid-looking label chain right before a broken tail',
        'abc123-def456.'.repeat(14_000) + 'run.ap!',
      ],
      ['dense run.app-shaped repeats (entirely host-safe characters end to end)', 'a.run.app'.repeat(22_000)],
    ];

    for (const [label, input] of CASES) {
      it(`${label} (len=${input.length})`, () => {
        expect(input.length).toBeGreaterThanOrEqual(196_000);
        const start = Date.now();
        findRunAppHostLiterals(input);
        const elapsedMs = Date.now() - start;
        expect(elapsedMs, `took ${elapsedMs}ms — expected well under 1000ms`).toBeLessThan(500);
      });
    }
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

describe('findRunAppViolations — symlink handling (audit point (b))', () => {
  // A tracked symlink whose TARGET PATH TEXT itself contains ".run.app"
  // passes the git-grep prefilter (git greps the symlink blob's literal
  // target string, never dereferencing it), but must not be dereferenced by
  // this guard either — `fs.readFileSync` follows symlinks by default, so
  // without the `lstatSync(...).isFile()` guard in findRunAppViolations,
  // this would read whatever external file the symlink points at. Proves
  // (1) the guard does not crash on a tracked symlink, (2) it does not
  // report the symlink's path as a violation (its own target-path text
  // does contain ".run.app", but as a symlink it is skipped outright, not
  // scanned for a host literal), and (3) it never reads the linked-to
  // external file's real content.
  let repo: string;
  let externalDir: string;
  let externalTargetPath: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'run-app-guard-symlink-fixture-'));
    externalDir = mkdtempSync(join(tmpdir(), 'run-app-guard-symlink-external-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });

    // The external target's real content contains a DIFFERENT host literal
    // than anything in the symlink's own target-path text, so if this guard
    // ever dereferenced the symlink, the reported match would reveal it.
    externalTargetPath = join(externalDir, 'secret-outside-repo.txt');
    writeFileSync(externalTargetPath, 'external-only-marker.us-central1.run.app\n');

    // Symlink name ends in .ts (passes TEXT_EXTENSIONS) and its TARGET PATH
    // STRING contains ".run.app" so it survives the git-grep prefilter too.
    const symlinkPath = join(repo, 'link-target-name.run.app.ts');
    execFileSync('ln', ['-s', externalTargetPath, symlinkPath]);

    writeFileSync(join(repo, 'clean.ts'), "export const BASE = 'https://api.arkova.ai';\n");
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
  });

  it('does not crash, does not flag the symlink, and never surfaces the external target content', () => {
    const violations = findRunAppViolations(repo);
    const allMatchedLiterals = violations.flatMap((v) => v.matches);
    expect(allMatchedLiterals).not.toContain('external-only-marker.us-central1.run.app');
    const files = violations.map((v) => v.file);
    expect(files).not.toContain('link-target-name.run.app.ts');
  });
});

describe('findRunAppViolations — planted literal in a scratch copy of a real, non-allowlisted file', () => {
  // 2026-09-21 independent self-audit (SCRUM-3888), audit point (d): "prove
  // it bites" — rather than only a synthetic fixture file (above), copy an
  // ACTUAL non-allowlisted file from this repo (integrations/shared/src/
  // constants.ts — itself part of this PR, definitely not in
  // RUN_APP_ALLOWLIST) into a scratch temp-dir git fixture, append a fake
  // *.run.app literal to the copy, and assert the guard reports it. This
  // proves the guard fires against real repo file content and structure,
  // not just a hand-written minimal fixture.
  let repo: string;
  const REAL_FILE_REPO_RELATIVE = 'integrations/shared/src/constants.ts';
  const PLANTED_LITERAL = 'https://foo-123.us-central1.run.app';

  beforeAll(() => {
    const realFileAbsolutePath = resolve(import.meta.dirname, '..', '..', REAL_FILE_REPO_RELATIVE);
    const realFileContent = readFileSync(realFileAbsolutePath, 'utf8');
    // Sanity check on the fixture itself: the real file must NOT already
    // contain a run.app literal (it was fixed by this same PR) — otherwise
    // this test would prove nothing about the planted literal specifically.
    expect(findRunAppHostLiterals(realFileContent)).toHaveLength(0);

    repo = mkdtempSync(join(tmpdir(), 'run-app-guard-real-file-fixture-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });

    const copyDestination = join(repo, REAL_FILE_REPO_RELATIVE);
    mkdirSync(dirname(copyDestination), { recursive: true });
    copyFileSync(realFileAbsolutePath, copyDestination);
    appendFileSync(copyDestination, `\n// planted for test: ${PLANTED_LITERAL}\n`);

    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('flags the planted literal in the copied real file', () => {
    const violations = findRunAppViolations(repo);
    const match = violations.find((v) => v.file === REAL_FILE_REPO_RELATIVE);
    expect(match, `expected ${REAL_FILE_REPO_RELATIVE} to be flagged; violations were: ${JSON.stringify(violations)}`).toBeDefined();
    expect(match?.matches).toContain('foo-123.us-central1.run.app');
  });

  it('checkRunAppHostLiteral returns 1 (fail) against the planted-literal fixture', () => {
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
