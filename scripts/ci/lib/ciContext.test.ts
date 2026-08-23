/**
 * Tests for the live-label union in ciContext (fix/ci-override-labels-live-read).
 *
 * Root cause being fixed: ci.yml seeds PR_LABELS from the FROZEN pull_request
 * event payload (`join(github.event.pull_request.labels.*.name, ',')`), and the
 * `pull_request` trigger does not fire on `labeled`. So adding an override label
 * after a run, then `gh run rerun`, replays the frozen payload WITHOUT the label
 * — the override never takes effect. The fix makes label reads LIVE by unioning
 * the env-seeded set with labels fetched at runtime via `gh api`.
 *
 * These tests exercise the pure helpers (parsePrNumber / fetchLiveLabels /
 * resolvePrLabels) with the gh child-process call mocked — no network.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Repo root, for the cross-script assertions at the bottom of this file. */
const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

// Mock the child_process the module uses. We provide a default git passthrough
// so the module's import-time `resolveCommitOrFail` (git rev-parse) does not
// blow up when the module is first evaluated.
const execFileSyncMock = vi.fn();
vi.mock('node:child_process', () => {
  const execFileSync = (...args: unknown[]) => execFileSyncMock(...args);
  return { execFileSync, default: { execFileSync } };
});

const FORTY_HEX = 'a'.repeat(40);

function gitPassthrough(cmd: string, args: string[]): string {
  // resolveCommitOrFail -> git rev-parse --verify <ref>^{commit}
  if (cmd === 'git' && args[0] === 'rev-parse') return `${FORTY_HEX}\n`;
  return '';
}

let mod: typeof import('./ciContext.js');

beforeEach(async () => {
  vi.resetModules();
  execFileSyncMock.mockReset();
  // Default: only the import-time git call is expected; label calls overridden per-test.
  execFileSyncMock.mockImplementation((cmd: string, args: string[]) => gitPassthrough(cmd, args));
  // Clean PR-context env so a stray runner env doesn't leak into tests.
  delete process.env.GITHUB_REF;
  delete process.env.GITHUB_REF_NAME;
  delete process.env.GITHUB_REPOSITORY;
  delete process.env.PR_NUMBER;
  delete process.env.PR_LABELS;
  // Pin the gh/git binaries to the bare names so the existing `cmd === 'gh'` /
  // `cmd === 'git'` mock matchers stay valid. Production resolves `GH_BIN` /
  // `GIT_BIN` to fixed absolute paths (Sonar S4036) defaulting to /usr/bin/gh
  // and /usr/bin/git; dedicated tests below prove the overrides are honored.
  process.env.GH_BIN = 'gh';
  process.env.GIT_BIN = 'git';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parsePrNumber', () => {
  it('derives the PR number from GITHUB_REF (refs/pull/<N>/merge)', async () => {
    mod = await import('./ciContext.js');
    expect(mod.parsePrNumber({ GITHUB_REF: 'refs/pull/123/merge' })).toBe(123);
  });

  it('also accepts refs/pull/<N>/head', async () => {
    mod = await import('./ciContext.js');
    expect(mod.parsePrNumber({ GITHUB_REF: 'refs/pull/456/head' })).toBe(456);
  });

  it('falls back to an explicit PR_NUMBER env when GITHUB_REF is not a pull ref', async () => {
    mod = await import('./ciContext.js');
    expect(mod.parsePrNumber({ GITHUB_REF: 'refs/heads/main', PR_NUMBER: '789' })).toBe(789);
  });

  it('returns null when there is no PR context', async () => {
    mod = await import('./ciContext.js');
    expect(mod.parsePrNumber({ GITHUB_REF: 'refs/heads/main' })).toBeNull();
    expect(mod.parsePrNumber({})).toBeNull();
  });
});

describe('resolvePrLabels', () => {
  it('returns env-only labels when there is no PR context (unchanged behavior)', async () => {
    mod = await import('./ciContext.js');
    // gh must NOT be called when there is no PR number.
    const labels = mod.resolvePrLabels({ PR_LABELS: 'foo,bar' });
    expect(labels.sort()).toEqual(['bar', 'foo']);
    const ghCalls = execFileSyncMock.mock.calls.filter((c) => c[0] === 'gh');
    expect(ghCalls).toHaveLength(0);
  });

  it('unions live labels (from gh api) with env labels when a PR number is present', async () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh') return 'count-exact-allowed\nhandoff-narrative-only\n';
      return gitPassthrough(cmd, args);
    });
    mod = await import('./ciContext.js');
    const labels = mod.resolvePrLabels({
      GITHUB_REF: 'refs/pull/1298/merge',
      GITHUB_REPOSITORY: 'carson/arkova',
      PR_LABELS: 'foo', // env-seeded (frozen payload) — missing the override
    });
    // Live label `count-exact-allowed` (absent from env) is now present.
    expect(labels).toContain('count-exact-allowed');
    expect(labels).toContain('handoff-narrative-only');
    expect(labels).toContain('foo');
    // gh was invoked against the derived PR number + repo.
    const ghCall = execFileSyncMock.mock.calls.find((c) => c[0] === 'gh');
    expect(ghCall).toBeDefined();
    expect(ghCall![1]).toEqual(
      expect.arrayContaining(['api', 'repos/carson/arkova/issues/1298/labels']),
    );
  });

  it('dedupes labels present in both env and live sets', async () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh') return 'count-exact-allowed\nshared\n';
      return gitPassthrough(cmd, args);
    });
    mod = await import('./ciContext.js');
    const labels = mod.resolvePrLabels({
      GITHUB_REF: 'refs/pull/1/merge',
      GITHUB_REPOSITORY: 'carson/arkova',
      PR_LABELS: 'shared,foo',
    });
    expect(labels.filter((l) => l === 'shared')).toHaveLength(1);
  });

  it('falls back gracefully to env-only labels when the gh call throws', async () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh') throw new Error('gh: command not found');
      return gitPassthrough(cmd, args);
    });
    mod = await import('./ciContext.js');
    const labels = mod.resolvePrLabels({
      GITHUB_REF: 'refs/pull/1298/merge',
      GITHUB_REPOSITORY: 'carson/arkova',
      PR_LABELS: 'foo,bar',
    });
    expect(labels.sort()).toEqual(['bar', 'foo']);
  });

  it('does not call gh when GITHUB_REPOSITORY is absent (cannot build the API path)', async () => {
    mod = await import('./ciContext.js');
    const labels = mod.resolvePrLabels({
      GITHUB_REF: 'refs/pull/1298/merge',
      PR_LABELS: 'foo',
    });
    expect(labels).toEqual(['foo']);
    const ghCalls = execFileSyncMock.mock.calls.filter((c) => c[0] === 'gh');
    expect(ghCalls).toHaveLength(0);
  });

  it('invokes the gh binary at the fixed GH_BIN path, not via $PATH lookup (S4036)', async () => {
    // Override the resolved binary to a fixed absolute path and assert the
    // module shells out to *that* path verbatim — never the bare `gh` name.
    process.env.GH_BIN = '/custom/bin/gh';
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === '/custom/bin/gh') return 'count-exact-allowed\n';
      return gitPassthrough(cmd, args);
    });
    mod = await import('./ciContext.js');
    expect(mod.GH_BIN).toBe('/custom/bin/gh');
    const labels = mod.resolvePrLabels({
      GITHUB_REF: 'refs/pull/1298/merge',
      GITHUB_REPOSITORY: 'carson/arkova',
      PR_LABELS: 'foo',
    });
    expect(labels).toContain('count-exact-allowed');
    // The gh CLI was spawned by absolute path; the bare `gh` name was never used.
    expect(execFileSyncMock.mock.calls.some((c) => c[0] === '/custom/bin/gh')).toBe(true);
    expect(execFileSyncMock.mock.calls.some((c) => c[0] === 'gh')).toBe(false);
  });

  it('defaults GH_BIN to /usr/bin/gh when the env var is unset', async () => {
    delete process.env.GH_BIN;
    mod = await import('./ciContext.js');
    expect(mod.GH_BIN).toBe('/usr/bin/gh');
  });
});

/**
 * The degradation used to be structurally invisible: the `gh` call was wrapped
 * in a bare `catch { return [] }` with stderr routed to `ignore`, so a job whose
 * env carries no GH_TOKEN/GITHUB_TOKEN fell back to the FROZEN pull_request
 * payload with NOTHING in the log. Every label-gated override in that job was
 * inert and the only symptom was "I applied the label, re-ran the job, and it
 * still failed" (PR #2322, 2026-08-22).
 *
 * The fallback stays non-fatal — these tests pin that it is now also LOUD, and
 * that the genuinely-empty case does NOT cry wolf.
 */
describe('fetchLiveLabels failure is annotated, not silent', () => {
  const PR_ENV = { GITHUB_REF: 'refs/pull/2322/merge', GITHUB_REPOSITORY: 'carson/arkova' };

  function failGh(message = 'gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.') {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh') throw Object.assign(new Error('Command failed'), { stderr: `${message}\n` });
      return gitPassthrough(cmd, args);
    });
  }

  it('emits a ::warning when the gh call fails inside a real PR context', async () => {
    failGh();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mod = await import('./ciContext.js');
    mod.resolvePrLabels({ ...PR_ENV, PR_LABELS: 'foo' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('::warning title=Live PR label fetch failed::');
    expect(warn.mock.calls[0][0]).toContain('#2322');
  });

  it('still returns the env-only labels — the annotation must not turn this fatal', async () => {
    failGh();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mod = await import('./ciContext.js');
    expect(mod.resolvePrLabels({ ...PR_ENV, PR_LABELS: 'foo,bar' }).sort()).toEqual(['bar', 'foo']);
  });

  it('names the missing token as the cause when neither GH_TOKEN nor GITHUB_TOKEN is set', async () => {
    failGh();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mod = await import('./ciContext.js');
    mod.resolvePrLabels({ ...PR_ENV });
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain('neither GH_TOKEN nor GITHUB_TOKEN is set');
    // The remediation must be actionable without reading this source file.
    expect(msg).toContain('secrets.GITHUB_TOKEN');
    // And it must surface gh's own reason, not just our narrative.
    expect(msg).toContain('set the GH_TOKEN environment variable');
  });

  it('does NOT blame a missing token when one is present (real gh/API/timeout failure)', async () => {
    failGh('gh: Not Found (HTTP 404)');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mod = await import('./ciContext.js');
    mod.resolvePrLabels({ ...PR_ENV, GH_TOKEN: 'ghs_live' });
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain('a token IS present');
    expect(msg).not.toContain('neither GH_TOKEN nor GITHUB_TOKEN is set');
  });

  it('stays SILENT with no PR context — a push build is legitimately empty, not broken', async () => {
    failGh();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mod = await import('./ciContext.js');
    expect(mod.resolvePrLabels({ GITHUB_REF: 'refs/heads/main', PR_LABELS: 'foo' })).toEqual(['foo']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent when the gh call succeeds', async () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh') return 'agents-md-deletion-approved\n';
      return gitPassthrough(cmd, args);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mod = await import('./ciContext.js');
    expect(mod.resolvePrLabels({ ...PR_ENV })).toEqual(['agents-md-deletion-approved']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once per process, not once per hasLabel() call', async () => {
    // dependency-scan runs ~11 label-gated steps and hasLabel() re-resolves on
    // every call — an un-deduped warning would bury the log.
    failGh();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mod = await import('./ciContext.js');
    process.env.GITHUB_REF = PR_ENV.GITHUB_REF;
    process.env.GITHUB_REPOSITORY = PR_ENV.GITHUB_REPOSITORY;
    mod.hasLabel('dep-range-intentional');
    mod.hasLabel('csp-runtime-deps-intentional');
    mod.resolvePrLabels({ ...PR_ENV });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('bounds a pathological gh error body so it cannot flood the log', async () => {
    failGh('x'.repeat(5_000));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mod = await import('./ciContext.js');
    mod.resolvePrLabels({ ...PR_ENV });
    expect(String(warn.mock.calls[0][0]).length).toBeLessThan(1_200);
  });

  it('pipes gh stderr so the reason is capturable (it used to be routed to `ignore`)', async () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh') return 'foo\n';
      return gitPassthrough(cmd, args);
    });
    mod = await import('./ciContext.js');
    mod.resolvePrLabels({ ...PR_ENV });
    const ghCall = execFileSyncMock.mock.calls.find((c) => c[0] === 'gh');
    expect((ghCall?.[2] as { stdio?: string[] })?.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });
});

describe('getBaseRef — lazy, memoized, fail-closed (ci/ciContext-lazy-baseref)', () => {
  it('does NOT invoke git on a labels/body-only import (no eager base resolution)', async () => {
    // The whole point of the lazy split: importing ciContext to read labels /
    // body must not shell out to `git rev-parse`. A check like
    // check-confluence-coverage imports prBody/hasLabel and never diffs.
    mod = await import('./ciContext.js');
    // Touch the labels/body surface — these are what a base-optional importer uses.
    void mod.prBody;
    void mod.prTitle;
    mod.resolvePrLabels({ PR_LABELS: 'foo' });
    const gitCalls = execFileSyncMock.mock.calls.filter((c) => c[0] === 'git');
    expect(gitCalls).toHaveLength(0);
  });

  it('getBaseRef({ required: true }) resolves the base on first call and memoizes it', async () => {
    mod = await import('./ciContext.js');
    const first = mod.getBaseRef({ required: true });
    expect(first).toBe(FORTY_HEX);
    const gitCallsAfterFirst = execFileSyncMock.mock.calls.filter((c) => c[0] === 'git').length;
    // Second call must be memoized — no additional git invocation.
    const second = mod.getBaseRef({ required: true });
    expect(second).toBe(FORTY_HEX);
    const gitCallsAfterSecond = execFileSyncMock.mock.calls.filter((c) => c[0] === 'git').length;
    expect(gitCallsAfterSecond).toBe(gitCallsAfterFirst);
  });

  it('getBaseRef({ required: true }) exits non-zero when the base is unresolvable (fail closed)', async () => {
    // git rev-parse throws ⇒ resolveCommitOrFail must process.exit(1).
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'git') throw new Error('fatal: ambiguous argument');
      return '';
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    mod = await import('./ciContext.js');
    expect(() => mod.getBaseRef({ required: true })).toThrow(/process\.exit\(1\)/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('getBaseRef({ required: true }) NEVER degrades to null/empty (does not return for required callers on failure)', async () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'git') throw new Error('fatal: bad revision');
      return '';
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}__`);
    }) as never);
    mod = await import('./ciContext.js');
    // A returned null/'' would be the dangerous degradation. Instead it MUST
    // throw via the mocked exit — never hand back a falsy base.
    let returned: unknown = 'NOT_CALLED';
    try {
      returned = mod.getBaseRef({ required: true });
    } catch (e) {
      returned = e;
    }
    expect(returned).toBeInstanceOf(Error);
    expect(returned).not.toBeNull();
    expect(returned).not.toBe('');
  });

  it('getBaseRef() (optional) returns null with a warning on an unresolvable base — no exit', async () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'git') throw new Error('fatal: bad revision');
      return '';
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mod = await import('./ciContext.js');
    expect(mod.getBaseRef({ required: false })).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('a required call after a failed optional call still fails closed (does not cache null for required callers)', async () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'git') throw new Error('fatal: bad revision');
      return '';
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    mod = await import('./ciContext.js');
    expect(mod.getBaseRef({ required: false })).toBeNull(); // optional: graceful null
    expect(() => mod.getBaseRef({ required: true })).toThrow(/process\.exit\(1\)/); // required: fail closed
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('changedFiles — PR-own-changeset anchoring, fail-closed base (FD-GATE-2)', () => {
  // FD-GATE-2: ci.yml and merge-authority.yml pass BASE_REF_SHA from the
  // FROZEN `github.event.pull_request.base.sha`, while HEAD is the LIVE
  // refs/pull/N/merge preview GitHub recomputes against current main. The old
  // two-dot `base..HEAD` therefore charged every base commit landed since the
  // PR's last push to the PR itself (162 "changed" files on a 6-file PR).
  // changedFiles now anchors the diff so base movement is never attributed to
  // the PR:
  //   - HEAD is the merge preview (pull merge ref + 2-parent HEAD whose FIRST
  //     parent descends from the env base) → diff HEAD^1..HEAD. HEAD^1 IS the
  //     live base tip the preview was built on, so this is exactly the PR's
  //     own changeset (conflict resolutions included).
  //   - raw head (local run, raw-head fallback) → diff merge-base(base,
  //     HEAD)..HEAD, i.e. three-dot semantics from the fork point.
  //   - merge-base unresolvable → fall back to the env base (legacy anchor);
  //     never degrade to [].
  const MERGE_BASE_SHA = 'b'.repeat(40);
  const HEAD_SHA = 'e'.repeat(40);
  const P1 = 'c'.repeat(40);
  const P2 = 'd'.repeat(40);

  const findDiffCall = () =>
    execFileSyncMock.mock.calls.find((c) => c[0] === 'git' && c[1][0] === 'diff');
  const rangeArgOf = (call: unknown[] | undefined) =>
    ((call?.[1] ?? []) as string[]).find((a) => a.includes('..'));

  it('anchors the diff at merge-base(base, HEAD), not at the (possibly frozen) env base', async () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'rev-parse') return `${FORTY_HEX}\n`;
      if (cmd === 'git' && args[0] === 'merge-base' && args[1] !== '--is-ancestor') {
        return `${MERGE_BASE_SHA}\n`;
      }
      if (cmd === 'git' && args[0] === 'diff') return 'a.ts\nb.ts\n';
      return '';
    });
    mod = await import('./ciContext.js');
    const files = mod.changedFiles();
    expect(files).toEqual(['a.ts', 'b.ts']);
    const diffCall = findDiffCall();
    expect(diffCall).toBeDefined();
    // The diff starts at the merge-base — base commits landed after the fork
    // point can never appear in the changeset.
    expect(rangeArgOf(diffCall)).toBe(`${MERGE_BASE_SHA}..HEAD`);
    // --diff-filter is preserved on the anchored diff.
    expect(diffCall![1] as string[]).toContain('--diff-filter=AMR');
  });

  it('diffs from HEAD^1 when HEAD is the GitHub merge preview (refs/pull/N/merge)', async () => {
    process.env.GITHUB_REF = 'refs/pull/2291/merge';
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'rev-parse') return `${FORTY_HEX}\n`;
      if (cmd === 'git' && args[0] === 'rev-list') return `${HEAD_SHA} ${P1} ${P2}\n`;
      // exit 0 → the env base IS an ancestor of HEAD^1 (i.e. HEAD^1 is the
      // live base tip, at or after the frozen base) → HEAD is the preview.
      if (cmd === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor') return '';
      if (cmd === 'git' && args[0] === 'diff') return 'own.ts\n';
      return '';
    });
    mod = await import('./ciContext.js');
    expect(mod.changedFiles()).toEqual(['own.ts']);
    expect(rangeArgOf(findDiffCall())).toBe('HEAD^1..HEAD');
    // The ancestry probe asked about the FIRST parent (the live base tip).
    const ancestryCall = execFileSyncMock.mock.calls.find(
      (c) => c[0] === 'git' && (c[1] as string[])[1] === '--is-ancestor',
    );
    expect(ancestryCall).toBeDefined();
    expect(ancestryCall![1]).toEqual(['merge-base', '--is-ancestor', FORTY_HEX, P1]);
  });

  it('does NOT use HEAD^1 for a raw branch head whose tip merely merges another branch', async () => {
    // staging-evidence.yml's raw-head fallback checks out the BRANCH head under
    // the same refs/pull/N/merge GITHUB_REF. A branch tip that is itself a
    // merge commit (main merged into the branch) has 2 parents, but its first
    // parent is the PREVIOUS branch head — which the env base does not
    // descend into. The ancestry probe fails → merge-base anchoring.
    process.env.GITHUB_REF = 'refs/pull/2291/merge';
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'rev-parse') return `${FORTY_HEX}\n`;
      if (cmd === 'git' && args[0] === 'rev-list') return `${HEAD_SHA} ${P1} ${P2}\n`;
      if (cmd === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        throw Object.assign(new Error('not an ancestor'), { status: 1 });
      }
      if (cmd === 'git' && args[0] === 'merge-base') return `${MERGE_BASE_SHA}\n`;
      if (cmd === 'git' && args[0] === 'diff') return 'x.ts\n';
      return '';
    });
    mod = await import('./ciContext.js');
    expect(mod.changedFiles()).toEqual(['x.ts']);
    expect(rangeArgOf(findDiffCall())).toBe(`${MERGE_BASE_SHA}..HEAD`);
  });

  it('does NOT use HEAD^1 for a single-parent HEAD even on the pull merge ref', async () => {
    process.env.GITHUB_REF = 'refs/pull/2291/merge';
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'rev-parse') return `${FORTY_HEX}\n`;
      if (cmd === 'git' && args[0] === 'rev-list') return `${HEAD_SHA} ${P1}\n`;
      if (cmd === 'git' && args[0] === 'merge-base' && args[1] !== '--is-ancestor') {
        return `${MERGE_BASE_SHA}\n`;
      }
      if (cmd === 'git' && args[0] === 'diff') return 'y.ts\n';
      return '';
    });
    mod = await import('./ciContext.js');
    expect(mod.changedFiles()).toEqual(['y.ts']);
    expect(rangeArgOf(findDiffCall())).toBe(`${MERGE_BASE_SHA}..HEAD`);
  });

  it('never consults HEAD parents outside a pull-request merge ref', async () => {
    process.env.GITHUB_REF = 'refs/heads/main';
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'rev-parse') return `${FORTY_HEX}\n`;
      if (cmd === 'git' && args[0] === 'merge-base' && args[1] !== '--is-ancestor') {
        return `${MERGE_BASE_SHA}\n`;
      }
      if (cmd === 'git' && args[0] === 'diff') return 'z.ts\n';
      return '';
    });
    mod = await import('./ciContext.js');
    expect(mod.changedFiles()).toEqual(['z.ts']);
    expect(rangeArgOf(findDiffCall())).toBe(`${MERGE_BASE_SHA}..HEAD`);
    // On a push build HEAD may be a merge commit too — the preview path must be
    // gated on the ref, so rev-list is never even invoked here.
    const revListCalls = execFileSyncMock.mock.calls.filter(
      (c) => c[0] === 'git' && (c[1] as string[])[0] === 'rev-list',
    );
    expect(revListCalls).toHaveLength(0);
  });

  it('falls back to the env base when merge-base cannot resolve (legacy anchor, never [])', async () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'rev-parse') return `${FORTY_HEX}\n`;
      if (cmd === 'git' && args[0] === 'merge-base') throw new Error('fatal: no merge base');
      if (cmd === 'git' && args[0] === 'diff') return 'a.ts\n';
      return '';
    });
    mod = await import('./ciContext.js');
    expect(mod.changedFiles()).toEqual(['a.ts']);
    expect(rangeArgOf(findDiffCall())).toBe(`${FORTY_HEX}..HEAD`);
  });

  it('fails closed (exits) when the base is unresolvable instead of returning [] (no silent path-gate bypass)', async () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'rev-parse') throw new Error('fatal: bad revision');
      return '';
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    mod = await import('./ciContext.js');
    // Old behavior returned [] here (gate passes wrongly). New behavior throws.
    expect(() => mod.changedFiles()).toThrow(/process\.exit\(1\)/);
  });
});

describe('GIT_BIN — fixed absolute path, no bare-binary $PATH lookup (S4036)', () => {
  it('spawns git at the resolved GIT_BIN path, not the bare `git` name', async () => {
    process.env.GIT_BIN = '/custom/bin/git';
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === '/custom/bin/git' && args[0] === 'rev-parse') return `${FORTY_HEX}\n`;
      if (cmd === '/custom/bin/git' && args[0] === 'diff') return 'a.ts\n';
      return '';
    });
    mod = await import('./ciContext.js');
    expect(mod.GIT_BIN).toBe('/custom/bin/git');
    expect(mod.changedFiles()).toEqual(['a.ts']);
    // Every git spawn used the absolute path; the bare `git` name was never used.
    expect(execFileSyncMock.mock.calls.some((c) => c[0] === '/custom/bin/git')).toBe(true);
    expect(execFileSyncMock.mock.calls.some((c) => c[0] === 'git')).toBe(false);
  });

  it('defaults GIT_BIN to /usr/bin/git when the env var is unset', async () => {
    delete process.env.GIT_BIN;
    mod = await import('./ciContext.js');
    expect(mod.GIT_BIN).toBe('/usr/bin/git');
  });
});

describe('hasLabel (live-aware)', () => {
  it('returns true for a label present only in the live set', async () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh') return 'count-exact-allowed\n';
      return gitPassthrough(cmd, args);
    });
    process.env.GITHUB_REF = 'refs/pull/1326/merge';
    process.env.GITHUB_REPOSITORY = 'carson/arkova';
    process.env.PR_LABELS = ''; // frozen payload had no labels
    mod = await import('./ciContext.js');
    expect(mod.hasLabel('count-exact-allowed')).toBe(true);
  });

  it('returns false for an absent label and does not throw on env-only runs', async () => {
    process.env.PR_LABELS = 'foo';
    mod = await import('./ciContext.js');
    expect(mod.hasLabel('count-exact-allowed')).toBe(false);
    expect(mod.hasLabel('foo')).toBe(true);
  });
});

/**
 * PR_COMMITS_MSGS by file, not by env string (E2BIG).
 *
 * The aggregated commit messages used to reach check-handoff-claims.ts and
 * check-confluence-coverage.ts as a single environment VARIABLE. Linux caps a
 * single envp string at MAX_ARG_STRLEN = 131,072 bytes, so a large enough
 * aggregate made `execve` of the consuming step's /usr/bin/bash fail with
 * E2BIG ("Argument list too long") before any script logic ran — no override
 * label can rescue a failure at process spawn. Measured on PR #2346 (run
 * 32666797304): 138,166 bytes, killing the HANDOFF.md verification lint step.
 *
 * The payload now travels as a FILE path (PR_COMMITS_MSGS_FILE), which has no
 * such ceiling. PR_COMMITS_MSGS survives only as a size-capped fallback for
 * local runs and for any caller that has not been re-plumbed.
 */
describe('resolvePrCommitsMsgs — file-first, env fallback (E2BIG)', () => {
  const MAX_ARG_STRLEN = 131_072;
  let msgsTmp: string;

  beforeEach(() => {
    msgsTmp = mkdtempSync(join(tmpdir(), 'arkova-ctx-msgs-'));
    delete process.env.PR_COMMITS_MSGS;
    delete process.env.PR_COMMITS_MSGS_FILE;
  });

  afterEach(() => {
    rmSync(msgsTmp, { recursive: true, force: true });
  });

  it('reads the file when PR_COMMITS_MSGS_FILE is set', async () => {
    const path = join(msgsTmp, 'msgs.txt');
    writeFileSync(path, 'feat: from file\n');
    process.env.PR_COMMITS_MSGS_FILE = path;
    process.env.PR_COMMITS_MSGS = 'feat: from env\n';
    mod = await import('./ciContext.js');

    expect(mod.resolvePrCommitsMsgs()).toBe('feat: from file\n');
    expect(mod.prCommitsMsgs()).toBe('feat: from file\n');
  });

  it('carries a payload larger than MAX_ARG_STRLEN, which is the whole point', async () => {
    const big = `${'y'.repeat(138_166)}\n`;
    const path = join(msgsTmp, 'big.txt');
    writeFileSync(path, big);
    process.env.PR_COMMITS_MSGS_FILE = path;
    mod = await import('./ciContext.js');

    const resolved = mod.resolvePrCommitsMsgs();
    expect(Buffer.byteLength(resolved)).toBeGreaterThan(MAX_ARG_STRLEN);
    expect(resolved).toBe(big);
  });

  it('falls back to PR_COMMITS_MSGS when no file is declared (unchanged legacy behavior)', async () => {
    process.env.PR_COMMITS_MSGS = 'feat: env only\n';
    mod = await import('./ciContext.js');

    expect(mod.resolvePrCommitsMsgs()).toBe('feat: env only\n');
  });

  it('returns empty string when neither source is present', async () => {
    mod = await import('./ciContext.js');
    expect(mod.resolvePrCommitsMsgs()).toBe('');
  });

  it('ANNOTATES the fallback when a declared file cannot be read — never silently', async () => {
    // Silence here would degrade the gates to a truncated (or empty) haystack
    // while still reporting green. The annotation is what makes that visible.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.PR_COMMITS_MSGS_FILE = join(msgsTmp, 'does-not-exist.txt');
    process.env.PR_COMMITS_MSGS = 'feat: capped fallback\n';
    mod = await import('./ciContext.js');

    expect(mod.resolvePrCommitsMsgs()).toBe('feat: capped fallback\n');
    expect(err).toHaveBeenCalled();
    const annotation = err.mock.calls.flat().join(' ');
    expect(annotation).toContain('::error::');
    expect(annotation).toContain('PR_COMMITS_MSGS_FILE');
  });

  it('ignores a whitespace-only file path rather than treating it as a real target', async () => {
    process.env.PR_COMMITS_MSGS_FILE = '   ';
    process.env.PR_COMMITS_MSGS = 'feat: env\n';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mod = await import('./ciContext.js');

    expect(mod.resolvePrCommitsMsgs()).toBe('feat: env\n');
    expect(err).not.toHaveBeenCalled();
  });

  it('does NOT read the file at import time — the producer imports this module before writing it', async () => {
    // scripts/ci/aggregate-commit-messages.ts imports ciContext to borrow
    // resolveDiffBase and runs BEFORE the file exists. An eager read there
    // fired the not-readable ::error:: annotation on every CI run, from the
    // very step whose job is to create the file.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.PR_COMMITS_MSGS_FILE = join(msgsTmp, 'not-yet-written.txt');
    mod = await import('./ciContext.js');

    expect(err, 'importing ciContext must not touch PR_COMMITS_MSGS_FILE').not.toHaveBeenCalled();

    // Reading it is what triggers resolution — and it is memoized thereafter.
    expect(mod.prCommitsMsgs()).toBe('');
    expect(err).toHaveBeenCalledTimes(1);
    mod.prCommitsMsgs();
    expect(err, 'the payload must be memoized, not re-read per call').toHaveBeenCalledTimes(1);
  });

  it('is honored by both governance gates through the shared export', async () => {
    // check-handoff-claims.ts and check-confluence-coverage.ts both read
    // `prCommitsMsgs`; a fix applied to only one of them would leave the other
    // spawning with the oversized env var.
    for (const script of ['check-handoff-claims.ts', 'check-confluence-coverage.ts']) {
      const source = readFileSync(resolve(REPO_ROOT, 'scripts/ci', script), 'utf8');
      expect(source, `${script} must read commit messages via ciContext`).toMatch(
        /\bprCommitsMsgs\(\)/u,
      );
    }
  });
});
