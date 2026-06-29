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
