/**
 * Integration tests for check-handoff-claims.ts (SCRUM-1252 / R0-6).
 *
 * Focus: the two-dot vs three-dot getDiff() fix (ci/ciContext-lazy-baseref).
 *
 * Root cause being fixed: getDiff() used `git diff <BASE>...HEAD` (THREE-dot =
 * diff vs the merge-base). A rebased lane branch (lane2/*-wt) reaches the
 * now-merged HANDOFF.md commit, so the three-dot diff re-surfaces that edit as
 * if the PR authored it — and the footer/claims check then fails on on-disk
 * HANDOFF.md even though the PR never touched HANDOFF.md. Two-dot (`<BASE>..HEAD`)
 * asks the correct question and does NOT attribute the stale commit.
 *
 * These tests drive the REAL CLI against throwaway git repositories so the
 * git-range semantics are exercised end-to-end (a mocked unit test cannot catch
 * a two-dot/three-dot range bug).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

const VALID_FOOTER =
  '_Last refreshed: 2026-06-30 by carson — claims verified against gcloud/MCP/CI output._';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Run the check CLI in `cwd` (a fixture repo) with the given env. */
function runCheck(
  cwd: string,
  env: Record<string, string>,
): { code: number; out: string } {
  try {
    const out = execFileSync('npx', ['tsx', resolve(cwd, 'scripts/ci/check-handoff-claims.ts')], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'handoff-claims-'));
  // The CLI imports ./lib/ciContext.js and resolves REPO relative to the script.
  // Copy the real script + its lib into the fixture so imports resolve.
  mkdirSync(resolve(dir, 'scripts/ci/lib'), { recursive: true });
  cpSync(resolve(REPO_ROOT, 'scripts/ci/check-handoff-claims.ts'), resolve(dir, 'scripts/ci/check-handoff-claims.ts'));
  cpSync(resolve(REPO_ROOT, 'scripts/ci/lib'), resolve(dir, 'scripts/ci/lib'), { recursive: true });

  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@arkova.io');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('getDiff two-dot vs three-dot (rebased-lane false-positive)', () => {
  it('does NOT fire when HANDOFF.md is reachable-in-history but NOT in the PR changeset (rebased lane)', () => {
    // main: create HANDOFF.md with a VALID footer (this is the merged base state).
    writeFileSync(resolve(dir, 'HANDOFF.md'), `# Handoff\n\nSome state.\n\n${VALID_FOOTER}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base: handoff exists');

    // A later commit on main edits HANDOFF (this is the "now-merged" commit a
    // rebased lane branch reaches). The lane PR's base tip is THIS commit.
    writeFileSync(resolve(dir, 'HANDOFF.md'), `# Handoff\n\nUpdated state on main.\n\n${VALID_FOOTER}\n`);
    git(dir, 'commit', '-aqm', 'docs(handoff): later main edit (the stale commit)');
    const mainTip = git(dir, 'rev-parse', 'HEAD');

    // Lane PR branch off mainTip: edits a CI file ONLY, not HANDOFF.md.
    git(dir, 'checkout', '-qb', 'lane2-wt');
    writeFileSync(resolve(dir, 'scripts/ci/somefile.txt'), 'lane work\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'ci: lane-2 work (no HANDOFF edit)');
    const headSha = git(dir, 'rev-parse', 'HEAD');

    // Two-dot (`mainTip..HEAD`) shows ONLY the lane commit (no HANDOFF change),
    // so the gate must NOT fire. (The old three-dot form against an earlier base
    // would have re-surfaced the mainTip HANDOFF edit and failed.)
    const r = runCheck(dir, {
      BASE_REF_SHA: mainTip,
      HEAD_REF_SHA: headSha,
      PR_BODY: 'CI tooling only. No HANDOFF edit.',
      PR_COMMITS_MSGS: 'ci: lane-2 work',
    });

    expect(r.out).toMatch(/HANDOFF\.md not modified by this PR|claims pass verification check/);
    expect(r.code).toBe(0);
  });

  it('still FAILS when the PR genuinely edits HANDOFF.md with an unverified prod claim (gate not weakened)', () => {
    // base: HANDOFF with valid footer.
    writeFileSync(resolve(dir, 'HANDOFF.md'), `# Handoff\n\nClean.\n\n${VALID_FOOTER}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    const base = git(dir, 'rev-parse', 'HEAD');

    // PR branch: add an unverified "deployed, healthy" claim, no artifact in body.
    git(dir, 'checkout', '-qb', 'pr');
    writeFileSync(
      resolve(dir, 'HANDOFF.md'),
      `# Handoff\n\nClean.\n\nrev arkova-worker-00397-9jm deployed, healthy.\n\n${VALID_FOOTER}\n`,
    );
    git(dir, 'commit', '-aqm', 'handoff: claim deploy');
    const head = git(dir, 'rev-parse', 'HEAD');

    const r = runCheck(dir, {
      BASE_REF_SHA: base,
      HEAD_REF_SHA: head,
      PR_BODY: 'No verification artifact here.',
      PR_COMMITS_MSGS: 'handoff: claim deploy',
    });

    expect(r.code).toBe(1);
    expect(r.out).toMatch(/asserts prod state without verification artifact/);
  });

  it('PASSES when the PR edits HANDOFF.md and DOES provide the verification artifact', () => {
    writeFileSync(resolve(dir, 'HANDOFF.md'), `# Handoff\n\nClean.\n\n${VALID_FOOTER}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    const base = git(dir, 'rev-parse', 'HEAD');

    git(dir, 'checkout', '-qb', 'pr');
    writeFileSync(
      resolve(dir, 'HANDOFF.md'),
      `# Handoff\n\nClean.\n\nrev arkova-worker-00397-9jm deployed, healthy.\n\n${VALID_FOOTER}\n`,
    );
    git(dir, 'commit', '-aqm', 'handoff: claim deploy with proof');
    const head = git(dir, 'rev-parse', 'HEAD');

    const r = runCheck(dir, {
      BASE_REF_SHA: base,
      HEAD_REF_SHA: head,
      PR_BODY: 'Verified: gcloud run services describe arkova-worker shows the rev serving traffic.',
      PR_COMMITS_MSGS: 'handoff: claim deploy with proof',
    });

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/claims pass verification check/);
  });
});
