/**
 * randomSuffixHex tests — SonarCloud typescript:S2245 (SCRUM-3167 batch item 25).
 *
 * `Math.random()` is flagged as a security-sensitive PRNG by Sonar even in
 * contexts (a friendly-name uniqueness suffix) that need no cryptographic
 * guarantee — the fix is a real CSPRNG (`crypto.getRandomValues`) rather
 * than arguing the finding away, since it costs nothing here and clears the
 * PR's `new_security_rating` quality gate.
 */
import { describe, expect, it, vi } from 'vitest';
import { randomSuffixHex } from './random';

describe('randomSuffixHex', () => {
  it('returns 4 lowercase hex characters by default', () => {
    const suffix = randomSuffixHex();
    expect(suffix).toMatch(/^[0-9a-f]{4}$/);
  });

  it('returns 2*byteLength hex characters for a custom byte length', () => {
    expect(randomSuffixHex(3)).toMatch(/^[0-9a-f]{6}$/);
    expect(randomSuffixHex(1)).toMatch(/^[0-9a-f]{2}$/);
  });

  it('two consecutive calls differ (not a fixed/deterministic value)', () => {
    const seen = new Set(Array.from({ length: 20 }, () => randomSuffixHex()));
    // Extremely unlikely to collide 20/20 times over a real CSPRNG; a
    // constant or broken implementation would collapse this to size 1.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('sources bytes from crypto.getRandomValues (the CSPRNG), not a hand-rolled PRNG', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    randomSuffixHex();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
    spy.mockRestore();
  });
});
