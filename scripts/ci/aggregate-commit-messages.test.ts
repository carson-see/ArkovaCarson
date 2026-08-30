/**
 * Tests for the commit-message aggregator (E2BIG fix).
 *
 * Root cause being fixed: ci.yml's `Aggregate commit messages` step aggregated
 * `git log --format=%B "$BASE_SHA"..HEAD` into a $GITHUB_OUTPUT value that was
 * then injected as the PR_COMMITS_MSGS **environment variable** into the
 * HANDOFF-claims and Confluence-coverage steps. Linux caps a single
 * argv/envp string at MAX_ARG_STRLEN = 131,072 bytes, so once the aggregate
 * crossed that, `execve` of the consuming step's `/usr/bin/bash` failed with
 * E2BIG — "Argument list too long" — BEFORE any script logic ran. No override
 * label can help a failure that happens at process spawn.
 *
 * Measured on PR #2346 (run 32666797304, job 97261336883, 2026-08-23): 153
 * commits / 138,166 bytes, killed the `HANDOFF.md verification lint` step.
 *
 * TWO independent causes compounded, and both are closed here: the payload now
 * travels by FILE instead of an env string (resolvePrCommitsMsgs in
 * lib/ciContext reads it), and the range is anchored at the PR's own changeset
 * instead of the frozen event base — the base drift is what turned 6 real
 * commits into 153 (the FD-GATE-2 shape, already fixed for `changedFiles`).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSyncMock = vi.fn();
vi.mock('node:child_process', () => {
  const execFileSync = (...args: unknown[]) => execFileSyncMock(...args);
  return { execFileSync, default: { execFileSync } };
});

const BASE_SHA = 'a'.repeat(40);
const MERGE_BASE_SHA = 'b'.repeat(40);
const P1 = 'c'.repeat(40);
const P2 = 'd'.repeat(40);
const HEAD_SHA = 'e'.repeat(40);
const TWO_COMMITS = 'feat: one\n\nfeat: two\n';

let mod: typeof import('./aggregate-commit-messages.js');
let tmp: string;

/** The `git log` invocation the module made, if any. */
const logCall = () =>
  execFileSyncMock.mock.calls.find((c) => c[0] === 'git' && (c[1] as string[])[0] === 'log');
const logArgs = () => (logCall()?.[1] ?? []) as string[];

/**
 * Point PR_COMMITS_MSGS_FILE at a path that already exists — ciContext reads
 * it eagerly at import, and a missing file would emit its (correct) fallback
 * annotation as test noise.
 */
function targetFile(name: string): string {
  const path = join(tmp, name);
  writeFileSync(path, '');
  process.env.PR_COMMITS_MSGS_FILE = path;
  return path;
}

beforeEach(() => {
  vi.resetModules();
  execFileSyncMock.mockReset();
  execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === 'git' && args[0] === 'rev-parse') return `${BASE_SHA}\n`;
    if (cmd === 'git' && args[0] === 'log') return TWO_COMMITS;
    return '';
  });
  delete process.env.GITHUB_REF;
  delete process.env.BASE_REF;
  delete process.env.BASE_REF_SHA;
  delete process.env.PR_COMMITS_MSGS_FILE;
  process.env.GIT_BIN = 'git';
  tmp = mkdtempSync(join(tmpdir(), 'arkova-msgs-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('commitMessagesForPr — range anchoring', () => {
  it('anchors at HEAD^1 when HEAD is the GitHub merge preview, so base drift cannot inflate the range', async () => {
    // THE #2346 CASE. `pull_request.base.sha` is refreshed by `synchronize` but
    // NOT by close/reopen, so an old PR accumulates every commit main took
    // since its last push. HEAD^1 is the live base tip the merge preview was
    // built on, which makes the range exactly the PR's own commits.
    process.env.BASE_REF_SHA = BASE_SHA;
    process.env.GITHUB_REF = 'refs/pull/2346/merge';
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'rev-parse') return `${BASE_SHA}\n`;
      if (cmd === 'git' && args[0] === 'rev-list') return `${HEAD_SHA} ${P1} ${P2}\n`;
      if (cmd === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor') return '';
      if (cmd === 'git' && args[0] === 'log') return 'feat: own commit\n';
      return '';
    });
    mod = await import('./aggregate-commit-messages.js');

    expect(mod.commitMessagesForPr()).toBe('feat: own commit\n');
    expect(logArgs()).toContain('HEAD^1..HEAD');
    // A plain merge-base anchor would NOT have fixed #2346: the frozen base is
    // an ancestor of the recomputed merge preview, so merge-base(base, HEAD)
    // returns the frozen base itself and the range stays inflated.
    expect(logArgs()).not.toContain(`${BASE_SHA}..HEAD`);
  });

  it('anchors at merge-base(base, HEAD) on a raw head', async () => {
    process.env.BASE_REF_SHA = BASE_SHA;
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'rev-parse') return `${BASE_SHA}\n`;
      if (cmd === 'git' && args[0] === 'merge-base' && args[1] !== '--is-ancestor') {
        return `${MERGE_BASE_SHA}\n`;
      }
      if (cmd === 'git' && args[0] === 'log') return 'fix: x\n';
      return '';
    });
    mod = await import('./aggregate-commit-messages.js');

    expect(mod.commitMessagesForPr()).toBe('fix: x\n');
    expect(logArgs()).toContain(`${MERGE_BASE_SHA}..HEAD`);
  });

  it('falls back to the single tip commit when no base is supplied (push builds)', async () => {
    // Preserves the pre-fix shell behavior verbatim: `git log --format=%B -1`.
    mod = await import('./aggregate-commit-messages.js');

    expect(mod.commitMessagesForPr()).toBe(TWO_COMMITS);
    expect(logArgs()).toContain('-1');
    expect(logArgs().some((a) => a.includes('..'))).toBe(false);
  });

  it('reads full commit bodies, not just subjects', async () => {
    mod = await import('./aggregate-commit-messages.js');
    mod.commitMessagesForPr();
    expect(logArgs()).toContain('--format=%B');
  });

  it('does not cap the git read at execFileSync\'s 1MB maxBuffer default', async () => {
    // A long-lived branch's aggregated log can exceed 1MB; ENOBUFS there would
    // just relocate the failure instead of fixing it.
    mod = await import('./aggregate-commit-messages.js');
    mod.commitMessagesForPr();
    const opts = logCall()?.[2] as { maxBuffer?: number } | undefined;
    expect(opts?.maxBuffer ?? 0).toBeGreaterThan(1024 * 1024);
  });
});

describe('writeCommitMessages — the file the gates actually read', () => {
  it('writes the aggregate to PR_COMMITS_MSGS_FILE and reports its size', async () => {
    const target = targetFile('pr-commit-msgs.txt');
    mod = await import('./aggregate-commit-messages.js');

    const result = mod.writeCommitMessages();

    expect(result.path).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe(TWO_COMMITS);
    expect(result.bytes).toBe(Buffer.byteLength(TWO_COMMITS));
  });

  it('fails CLOSED when PR_COMMITS_MSGS_FILE is unset rather than silently dropping the payload', async () => {
    // A silent no-op would leave both gates reading an empty haystack and
    // PASSING — the wrong direction for a governance check.
    mod = await import('./aggregate-commit-messages.js');
    expect(() => mod.writeCommitMessages()).toThrow(/PR_COMMITS_MSGS_FILE/u);
  });

  it('round-trips a payload at #2346 scale, past MAX_ARG_STRLEN, without truncation', async () => {
    const big = `${'x'.repeat(138_166)}\n`;
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'rev-parse') return `${BASE_SHA}\n`;
      if (cmd === 'git' && args[0] === 'log') return big;
      return '';
    });
    const target = targetFile('big.txt');
    mod = await import('./aggregate-commit-messages.js');

    const result = mod.writeCommitMessages();

    expect(result.bytes).toBeGreaterThan(131_072); // Linux MAX_ARG_STRLEN
    expect(readFileSync(target, 'utf8')).toBe(big);
  });
});
