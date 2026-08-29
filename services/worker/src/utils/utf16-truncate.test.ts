/**
 * Unit tests for `truncateUtf16Safe` — surrogate-safe UTF-16 truncation.
 *
 * Born from the 2026-08-17 poison-record incident: `.slice(0, N)` cuts at a
 * UTF-16 code-unit boundary, which can split a surrogate pair and leave a
 * lone high surrogate. Lone surrogates are invalid JSON payload content for
 * PostgREST (PGRST102) and cannot survive a UTF-8 round-trip into Postgres.
 */

import { describe, it, expect } from 'vitest';
import { truncateUtf16Safe } from './utf16-truncate.js';

const ASTRAL = '\u{1D54F}'; // 2 UTF-16 units
const LONE_HIGH = '\uD835';
const LONE_LOW = '\uDD4F';

function isWellFormedUtf16(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) return false;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    }
  }
  return true;
}

describe('truncateUtf16Safe', () => {
  it('runtime supports String.prototype.toWellFormed (Node >= 20, engines >=20.14.0)', () => {
    // Documents the environment assumption: the ES2024 guard path is ACTIVE in
    // CI and prod (node:20-alpine). The manual trailing-surrogate drop below
    // is what keeps the helper correct even where it is not.
    expect(typeof (String.prototype as { toWellFormed?: () => string }).toWellFormed).toBe('function');
  });

  it('returns short input unchanged', () => {
    expect(truncateUtf16Safe('hello', 500)).toBe('hello');
    expect(truncateUtf16Safe('', 500)).toBe('');
  });

  it('truncates at the limit when the cut lands between whole characters', () => {
    expect(truncateUtf16Safe('abcdef', 3)).toBe('abc');
  });

  it('drops the orphaned high surrogate when the cut splits a pair', () => {
    const input = 'ab' + ASTRAL + 'cd'; // units: a b HI LO c d
    const out = truncateUtf16Safe(input, 3); // cut inside the pair
    expect(out).toBe('ab');
    expect(isWellFormedUtf16(out)).toBe(true);
    expect(out).not.toContain('�');
  });

  it('preserves a complete pair that ends exactly at the limit', () => {
    const input = 'ab' + ASTRAL + 'cd';
    expect(truncateUtf16Safe(input, 4)).toBe('ab' + ASTRAL);
  });

  it('output always survives a UTF-8 round-trip at every cut point', () => {
    const input = ASTRAL.repeat(5); // 10 units, every odd cut splits a pair
    for (let max = 0; max <= input.length; max++) {
      const out = truncateUtf16Safe(input, max);
      expect(isWellFormedUtf16(out)).toBe(true);
      expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
      expect(out.length).toBeLessThanOrEqual(max);
    }
  });

  it('sanitizes pre-existing lone surrogates (defensive — cannot arrive from Postgres)', () => {
    // Interior lone surrogates cannot come out of jsonb (Postgres rejects
    // them), but the helper still guarantees a well-formed RESULT via the
    // toWellFormed guard so no caller can re-poison a JSON write path.
    expect(isWellFormedUtf16(truncateUtf16Safe('a' + LONE_HIGH + 'b', 500))).toBe(true);
    expect(isWellFormedUtf16(truncateUtf16Safe('a' + LONE_LOW + 'b', 500))).toBe(true);
    // A trailing lone high surrogate below the limit is removed, not kept.
    expect(isWellFormedUtf16(truncateUtf16Safe('ab' + LONE_HIGH, 500))).toBe(true);
  });
});
