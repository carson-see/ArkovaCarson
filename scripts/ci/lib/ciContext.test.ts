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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  // Pin the gh binary to the bare name so the existing `cmd === 'gh'` mock
  // matchers stay valid. Production resolves `GH_BIN` to a fixed absolute path
  // (Sonar S4036) defaulting to /usr/bin/gh; a dedicated test below proves the
  // override is honored.
  process.env.GH_BIN = 'gh';
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

describe('changedFiles — two-dot diff, fail-closed base (ci/ciContext-lazy-baseref)', () => {
  it('diffs with TWO-dot (base..HEAD), NOT three-dot (base...HEAD)', async () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'rev-parse') return `${FORTY_HEX}\n`;
      if (cmd === 'git' && args[0] === 'diff') return 'a.ts\nb.ts\n';
      return '';
    });
    mod = await import('./ciContext.js');
    const files = mod.changedFiles();
    expect(files).toEqual(['a.ts', 'b.ts']);
    const diffCall = execFileSyncMock.mock.calls.find((c) => c[0] === 'git' && c[1][0] === 'diff');
    expect(diffCall).toBeDefined();
    const rangeArg = (diffCall![1] as string[]).find((a) => a.includes('HEAD') && a.includes(FORTY_HEX));
    expect(rangeArg).toBe(`${FORTY_HEX}..HEAD`);
    // Explicitly assert the three-dot form is NOT used.
    expect(rangeArg).not.toContain('...');
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
