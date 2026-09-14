/**
 * SCRUM-3907 — unit tests for the edge deployed-version drift classifier.
 * Red-first: written before `check-edge-deployed-version.ts` existed.
 * All git/network I/O is injected or mocked — no real repo/network access.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { classifyDrift, formatReport, fetchEdgeHealth, parseArgs, type HealthResponse } from './check-edge-deployed-version.js';

const MAIN = 'a'.repeat(40);

function classify(overrides: {
  health?: HealthResponse | null;
  fetchError?: string | null;
  isAncestor?: boolean;
  commitsBehind?: number;
}) {
  return classifyDrift({
    health: overrides.health ?? null,
    fetchError: overrides.fetchError ?? null,
    mainSha: MAIN,
    isAncestor: () => overrides.isAncestor ?? true,
    commitsBehind: () => overrides.commitsBehind ?? 0,
  });
}

describe('classifyDrift', () => {
  it('reports match when the deployed SHA equals origin/main HEAD', () => {
    const result = classify({ health: { git_sha: MAIN, built_at: '2026-09-13T00:00:00.000Z' } });
    expect(result).toEqual({ kind: 'match', sha: MAIN });
  });

  it('reports behind when the deployed SHA is an ancestor of main but not HEAD', () => {
    const old = 'b'.repeat(40);
    const result = classify({ health: { git_sha: old }, isAncestor: true, commitsBehind: 7 });
    expect(result).toEqual({ kind: 'behind', deployedSha: old, mainSha: MAIN, commitsBehind: 7 });
  });

  it('reports diverged when the deployed SHA is not an ancestor of main at all', () => {
    const off = 'c'.repeat(40);
    const result = classify({ health: { git_sha: off }, isAncestor: false });
    expect(result).toEqual({ kind: 'diverged', deployedSha: off, mainSha: MAIN });
  });

  it('reports missing-field when git_sha is absent from the response', () => {
    const result = classify({ health: { status: 'ok', service: 'arkova-edge' } });
    expect(result.kind).toBe('missing-field');
  });

  // typescript:S5976 -- these four all exercise the same
  // "unusable git_sha value -> missing-field" branch and differ only in
  // WHY the value is unusable: the two checked-in sentinels from
  // build-info.ts, and the two untrusted-input shapes (tssecurity:S6350 --
  // never let a value that isn't a real hex SHA reach a git argv position).
  it.each([
    ['local-dev', 'the checked-in placeholder (never deployed through the generator)'],
    ['unknown', 'the unresolvable-SHA sentinel (generator could not resolve a SHA)'],
    ['--upload-pack=/bin/sh', 'a command-line-flag shape (tssecurity:S6350)'],
    ['not-a-real-sha', 'a short/non-hex shape (untrusted-input guard)'],
  ])('reports missing-field for git_sha %j (%s)', (gitSha) => {
    const result = classify({ health: { git_sha: gitSha } });
    expect(result.kind).toBe('missing-field');
  });

  it('reports fetch-error when the health endpoint could not be reached, independent of any health body', () => {
    const result = classify({ health: { git_sha: MAIN }, fetchError: 'HTTP 503' });
    expect(result).toEqual({ kind: 'fetch-error', error: 'HTTP 503' });
  });

  it('reports missing-field when health is null (e.g. a 200 with an unparseable body)', () => {
    const result = classify({ health: null });
    expect(result.kind).toBe('missing-field');
  });

  it('normalizes a valid but mixed-case git_sha before it reaches isAncestor/commitsBehind', () => {
    const mixedCase = 'B'.repeat(20) + 'b'.repeat(20);
    const result = classify({ health: { git_sha: mixedCase }, isAncestor: true, commitsBehind: 3 });
    expect(result).toEqual({ kind: 'behind', deployedSha: mixedCase.toLowerCase(), mainSha: MAIN, commitsBehind: 3 });
  });
});

describe('formatReport', () => {
  it('strips control characters from a fetch-error message before logging it (tssecurity:S5145 -- log/workflow-command injection)', () => {
    const injected = 'HTTP 503\n::error::forged workflow command\r\x1b[31mred';
    const { message } = formatReport({ kind: 'fetch-error', error: injected });
    expect(message).not.toMatch(/[\r\n\x1b]/);
    expect(message).toContain('HTTP 503');
    expect(message).toContain('::error::forged workflow command');
  });

  it('is not drift for a match', () => {
    expect(formatReport({ kind: 'match', sha: MAIN }).isDrift).toBe(false);
  });

  it.each([
    { kind: 'behind', deployedSha: 'b'.repeat(40), mainSha: MAIN, commitsBehind: 3 } as const,
    { kind: 'diverged', deployedSha: 'c'.repeat(40), mainSha: MAIN } as const,
    { kind: 'missing-field', rawHealth: null } as const,
    { kind: 'fetch-error', error: 'timeout' } as const,
  ])('is drift for kind=$kind', (drift) => {
    expect(formatReport(drift).isDrift).toBe(true);
  });

  it('names the workflow_dispatch remedy in the behind message', () => {
    const { message } = formatReport({ kind: 'behind', deployedSha: 'b'.repeat(40), mainSha: MAIN, commitsBehind: 3 });
    expect(message).toContain('edge-deploy.yml');
  });
});

describe('fetchEdgeHealth', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('returns the parsed body on a 200', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ git_sha: MAIN }), { status: 200 })) as typeof fetch;
    const { health, error } = await fetchEdgeHealth('https://example.invalid/health');
    expect(error).toBeNull();
    expect(health).toEqual({ git_sha: MAIN });
  });

  it('reports an error string for a non-2xx response instead of throwing', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 503 })) as typeof fetch;
    const { health, error } = await fetchEdgeHealth('https://example.invalid/health');
    expect(health).toBeNull();
    expect(error).toBe('HTTP 503');
  });

  it('reports an error string when fetch itself throws (network failure)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network unreachable');
    }) as typeof fetch;
    const { health, error } = await fetchEdgeHealth('https://example.invalid/health');
    expect(health).toBeNull();
    expect(error).toBe('network unreachable');
  });
});

describe('parseArgs (rig support — release session fold on #2908)', () => {
  it('defaults to production /health, origin/main and warn-only', () => {
    expect(parseArgs([])).toEqual({ strict: false, url: 'https://edge.arkova.ai/health', expectedSha: null });
  });

  it('accepts --strict, --url and --expected-sha together', () => {
    const sha = 'b'.repeat(40);
    expect(parseArgs(['--strict', `--url=https://pr-1---arkova-edge.example.workers.dev/health`, `--expected-sha=${sha}`])).toEqual({
      strict: true,
      url: 'https://pr-1---arkova-edge.example.workers.dev/health',
      expectedSha: sha,
    });
  });

  it('lower-cases and validates --expected-sha so a typo cannot silently fall back to origin/main', () => {
    expect(parseArgs([`--expected-sha=${'C'.repeat(40)}`]).expectedSha).toBe('c'.repeat(40));
    expect(() => parseArgs(['--expected-sha=abc123'])).toThrow(/40-character/);
  });

  it('rejects a non-http --url', () => {
    expect(() => parseArgs(['--url=edge.arkova.ai/health'])).toThrow(/http\(s\)/);
  });

  it('ignores unknown flags (CI passes none today)', () => {
    expect(parseArgs(['--verbose']).strict).toBe(false);
  });
});
