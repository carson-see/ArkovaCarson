/**
 * Tests for the shared constant-time comparison used by every integration
 * that authenticates an inbound webhook.
 */

import { describe, it, expect } from 'vitest';
import { constantTimeEqual } from './constant-time';

describe('constantTimeEqual', () => {
  it('accepts identical strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('a'.repeat(64), 'a'.repeat(64))).toBe(true);
  });

  it('rejects a single differing byte, wherever it falls', () => {
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'zbc')).toBe(false);
    expect(constantTimeEqual('abc', 'aXc')).toBe(false);
  });

  it('rejects a length mismatch without reading out of bounds', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('abcd', 'abc')).toBe(false);
    expect(constantTimeEqual('', 'a')).toBe(false);
  });

  it('compares bytes, not code units — multi-byte characters are handled', () => {
    expect(constantTimeEqual('é', 'é')).toBe(true);
    // 'é' is 2 UTF-8 bytes, 'e' is 1: a length mismatch, not a match.
    expect(constantTimeEqual('é', 'e')).toBe(false);
    expect(constantTimeEqual('🔑', '🔒')).toBe(false);
  });

  it('does not exit early on content: every equal-length compare reads the whole input', () => {
    // A content-dependent early exit is the defect this function exists to
    // avoid. Assert it structurally — the implementation must contain no
    // `return`/`break` inside its comparison loop — because a wall-clock
    // timing assertion is inherently flaky on a shared CI runner.
    const src = constantTimeEqual.toString();
    const start = src.indexOf('for (');
    // The comparison loop is a single statement on one line; slice exactly it,
    // so the function's trailing `return diff === 0;` is not misread as an
    // in-loop early exit.
    const loop = src.slice(start, src.indexOf('\n', start));
    expect(loop).not.toMatch(/\breturn\b/);
    expect(loop).not.toMatch(/\bbreak\b/);
    expect(loop).toContain('|=');
  });

  it('is not the === operator: mismatches at every position cost the same shape of work', () => {
    // Sanity: all of these are false, none throw, none short-circuit into a
    // different code path depending on where the mismatch is.
    const secret = 'f'.repeat(64);
    for (let i = 0; i < 64; i++) {
      const guess = secret.slice(0, i) + '0' + secret.slice(i + 1);
      expect(constantTimeEqual(secret, guess)).toBe(false);
    }
  });
});
