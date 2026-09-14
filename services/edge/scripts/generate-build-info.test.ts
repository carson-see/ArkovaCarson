/**
 * SCRUM-3907 — unit tests for the build-info generator. Red-first: written
 * before `generate-build-info.mjs` existed, covering the pure render
 * function's shape/escaping and the SHA-resolution fallback chain.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderBuildInfoModule, resolveGitSha } from './generate-build-info.mjs';

describe('renderBuildInfoModule', () => {
  it('emits a git_sha and an ISO built_at when both are provided', () => {
    const src = renderBuildInfoModule('abc1234def5678901234567890123456789012', '2026-09-13T15:00:00.000Z');
    expect(src).toContain("git_sha: \"abc1234def5678901234567890123456789012\"");
    expect(src).toContain('built_at: "2026-09-13T15:00:00.000Z"');
    expect(src).toContain('export interface BuildInfo');
    expect(src).toContain('export const BUILD_INFO: BuildInfo = {');
  });

  it('emits a literal null (not the string "null") for a null built_at', () => {
    const src = renderBuildInfoModule('local-dev', null);
    expect(src).toContain('built_at: null,');
    expect(src).not.toContain('built_at: "null"');
  });

  it('falls back to "unknown" for a SHA that is not hex, "unknown", or "local-dev"', () => {
    // Defensive re-check: even if a caller passes something unsanitized in,
    // the generated TypeScript can never be corrupted by it.
    const src = renderBuildInfoModule('"; process.exit(1); //', null);
    expect(src).toContain('git_sha: "unknown"');
    expect(src).not.toContain('process.exit');
  });

  it('passes through the literal strings "unknown" and "local-dev"', () => {
    expect(renderBuildInfoModule('unknown', null)).toContain('git_sha: "unknown"');
    expect(renderBuildInfoModule('local-dev', null)).toContain('git_sha: "local-dev"');
  });

  it('produces syntactically parseable TypeScript (no unescaped braces/quotes)', () => {
    const src = renderBuildInfoModule('a'.repeat(40), '2026-01-01T00:00:00.000Z');
    // Cheap structural check without pulling in the TS compiler: braces balance.
    const opens = (src.match(/{/g) ?? []).length;
    const closes = (src.match(/}/g) ?? []).length;
    expect(opens).toBe(closes);
  });
});

describe('resolveGitSha', () => {
  const realEnv = { ...process.env };
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    process.env = { ...realEnv };
  });

  it('prefers an explicit hex SHA argument over everything else', () => {
    process.env.GITHUB_SHA = 'b'.repeat(40);
    expect(resolveGitSha('a'.repeat(40))).toBe('a'.repeat(40));
  });

  it('falls back to GITHUB_SHA when no explicit arg is given', () => {
    process.env.GITHUB_SHA = 'c'.repeat(40);
    expect(resolveGitSha(undefined)).toBe('c'.repeat(40));
  });

  it('lowercases a mixed-case hex SHA', () => {
    expect(resolveGitSha('A'.repeat(40))).toBe('a'.repeat(40));
  });

  it('rejects a non-hex explicit arg and falls through instead of using it', () => {
    delete process.env.GITHUB_SHA;
    const result = resolveGitSha('not-a-sha!!');
    // Falls through to `git rev-parse HEAD` (real repo in CI/dev) or 'unknown' —
    // either way it must NOT be the rejected literal.
    expect(result).not.toBe('not-a-sha!!');
  });
});
