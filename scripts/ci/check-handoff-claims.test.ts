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
import { createRequire } from 'node:module';
import { GIT_BIN } from './lib/ciContext.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

// Run the CLI via the CURRENT node binary (process.execPath is an absolute
// path) + the tsx loader resolved from node_modules — no bare-binary $PATH
// lookup (Sonar S4036). GIT_BIN is reused from ciContext for the same reason.
const NODE_BIN = process.execPath;
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

const VALID_FOOTER =
  '_Last refreshed: 2026-06-30 by carson — claims verified against gcloud/MCP/CI output._';

function git(cwd: string, ...args: string[]): string {
  return execFileSync(GIT_BIN, args, { cwd, encoding: 'utf8' }).trim();
}

/** Run the check CLI in `cwd` (a fixture repo) with the given env. */
function runCheck(
  cwd: string,
  env: Record<string, string>,
): { code: number; out: string } {
  try {
    const out = execFileSync(NODE_BIN, [TSX_CLI, resolve(cwd, 'scripts/ci/check-handoff-claims.ts')], {
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

describe('merge-ref checkout + stale pinned base (base-drift misattribution, 2026-07-06 f11a5290 class)', () => {
  it('does NOT fire when the BASE branch edited HANDOFF.md after the PR was cut (PR changeset has no HANDOFF edit)', () => {
    // Reproduces the 2026-07-06 incident: actions/checkout on pull_request
    // checks out the SYNTHETIC merge ref (PR head merged into CURRENT base
    // tip) while github.event.pull_request.base.sha stays pinned at
    // PR-creation time. A direct-to-main HANDOFF.md docs commit (f11a5290)
    // then surfaces in `pinnedBase..HEAD` for EVERY pre-drift PR, and the
    // footer check runs against a file this PR never touched.
    writeFileSync(resolve(dir, 'HANDOFF.md'), `# Handoff\n\nClean.\n\n${VALID_FOOTER}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base at PR creation');
    const pinnedBase = git(dir, 'rev-parse', 'HEAD');
    const initialBranch = git(dir, 'symbolic-ref', '--short', 'HEAD');

    // PR branch off pinnedBase: lane work only, NO HANDOFF edit.
    git(dir, 'checkout', '-qb', 'pr');
    writeFileSync(resolve(dir, 'scripts/ci/lane-work.txt'), 'chain work\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'feat(chain): lane work (no HANDOFF edit)');
    const prHead = git(dir, 'rev-parse', 'HEAD');

    // Base branch advances AFTER the PR was cut: a docs commit edits
    // HANDOFF.md mid-file and leaves a NON-conforming footer as the last
    // non-empty line (the exact f11a5290 shape).
    git(dir, 'checkout', '-q', initialBranch);
    writeFileSync(
      resolve(dir, 'HANDOFF.md'),
      `# Handoff\n\n### 2026-07-06 (RTE) - Sprint 4 priority set\n\nNarrative only; no runtime state changed.\n\n_Last refreshed: 2026-07-06 by Codex - claims verified against Drive folder ABC123._\n`,
    );
    git(dir, 'commit', '-aqm', 'docs: record Sprint 4 ART priority');
    const mainTip = git(dir, 'rev-parse', 'HEAD');

    // GitHub's synthetic refs/pull/N/merge commit: PR head merged into the
    // CURRENT base tip, with the canonical "Merge <sha> into <sha>" subject.
    git(dir, 'merge', '-q', '--no-ff', '-m', `Merge ${prHead} into ${mainTip}`, 'pr');
    const mergeSha = git(dir, 'rev-parse', 'HEAD');

    const r = runCheck(dir, {
      BASE_REF_SHA: pinnedBase,
      HEAD_REF_SHA: prHead,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_SHA: mergeSha,
      PR_BODY: 'Chain lane work. No HANDOFF edit in this PR.',
      PR_COMMITS_MSGS: 'feat(chain): lane work (no HANDOFF edit)',
    });

    expect(r.out).toMatch(/HANDOFF\.md not modified by this PR/);
    expect(r.code).toBe(0);
  });

  it('still FAILS on the merge-ref checkout when THIS PR genuinely edits HANDOFF.md with an unverified claim (gate not weakened)', () => {
    writeFileSync(resolve(dir, 'HANDOFF.md'), `# Handoff\n\nClean.\n\n${VALID_FOOTER}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base at PR creation');
    const pinnedBase = git(dir, 'rev-parse', 'HEAD');
    const initialBranch = git(dir, 'symbolic-ref', '--short', 'HEAD');

    // PR branch: adds an unverified prod claim to HANDOFF.md.
    git(dir, 'checkout', '-qb', 'pr');
    writeFileSync(
      resolve(dir, 'HANDOFF.md'),
      `# Handoff\n\nClean.\n\nrev arkova-worker-00397-9jm deployed, healthy.\n\n${VALID_FOOTER}\n`,
    );
    git(dir, 'commit', '-aqm', 'handoff: claim deploy');
    const prHead = git(dir, 'rev-parse', 'HEAD');

    // Base advances on an unrelated file (no merge conflict).
    git(dir, 'checkout', '-q', initialBranch);
    writeFileSync(resolve(dir, 'scripts/ci/other-lane.txt'), 'other lane\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'ci: unrelated base advance');
    const mainTip = git(dir, 'rev-parse', 'HEAD');

    git(dir, 'merge', '-q', '--no-ff', '-m', `Merge ${prHead} into ${mainTip}`, 'pr');
    const mergeSha = git(dir, 'rev-parse', 'HEAD');

    const r = runCheck(dir, {
      BASE_REF_SHA: pinnedBase,
      HEAD_REF_SHA: prHead,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_SHA: mergeSha,
      PR_BODY: 'No verification artifact here.',
      PR_COMMITS_MSGS: 'handoff: claim deploy',
    });

    expect(r.code).toBe(1);
    expect(r.out).toMatch(/asserts prod state without verification artifact/);
  });
});
