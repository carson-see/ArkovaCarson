/**
 * Adversarial coverage for `stripProfessionalEducationPii`'s email redaction.
 *
 * `stripSensitiveString` runs on arbitrary, UNCAPPED `Jsonish` values on the way
 * into the CPE/CLE extraction prompts, on a single-threaded worker, so a
 * quadratic redaction pass is an event-loop stall driven by document-derived
 * text. The regex this replaced was exactly that (Sonar typescript:S8786).
 *
 * Two things are pinned here, and the second is the one that matters:
 *   1. The scan is LINEAR (the perf ratchets below).
 *   2. It never redacts LESS than the pattern it replaced. Over-redaction is
 *      safe; under-redaction is a PII leak. The differential fuzz is the real
 *      gate — the ratchets only prove it is fast.
 */
import { describe, expect, it } from 'vitest';
import { stripProfessionalEducationPii } from './professional-education.js';

const strip = (value: string): string => stripProfessionalEducationPii(value) as string;

/**
 * The pattern this replaced, kept verbatim as the differential ORACLE. Every
 * `@` and every domain character it redacts must still be redacted today.
 */
const LEGACY_EMAIL_PATTERN = () => /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

describe('professional-education email redaction — linearity', () => {
  // Sized so the ceiling is a real ratchet, not a formality: each case measured
  // ~3,240-3,655 ms against the old pattern and under 1 ms against this
  // implementation, so 2 s sits far below the broken runtime and orders of
  // magnitude above the fixed one. It cannot flake either way.
  //
  // The shape matters. PR #2346's browser case — `'a'.repeat(n) + '@' + 'b'.repeat(n)` —
  // is NOT adversarial against the old pattern here, because its leading `\b`
  // collapses a pure-alphanumeric run to a single start offset (measured 0.3 ms).
  // A DOTTED run is the adversarial shape: `.` and `-` are local-part characters
  // but not word characters, so `\b` holds before every token. Using #2346's
  // input unchanged would have produced a ratchet that was green on the bug.
  it('handles a dotted local-part run with no @ in linear time', () => {
    const input = `${'a.'.repeat(40_000)}!`;
    const started = performance.now();
    strip(input);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('handles an ambiguous dotted domain that never completes in linear time', () => {
    const input = `x@${'a.'.repeat(45_000)}1`;
    const started = performance.now();
    strip(input);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('handles a dashed local-part run in linear time', () => {
    const input = `${'a-'.repeat(40_000)}!`;
    const started = performance.now();
    strip(input);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  // The @-anchored scan visits every '@'. This pins that a dense run of them
  // stays linear rather than trading one quadratic shape for another.
  it('handles an @-dense input in linear time', () => {
    const input = '@a.co'.repeat(40_000);
    const started = performance.now();
    strip(input);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('professional-education email redaction — never redacts less', () => {
  const count = (value: string, char: string): number => {
    let n = 0;
    for (const c of value) if (c === char) n += 1;
    return n;
  };

  /**
   * The exact invariant, and it is exact for the thing that matters.
   *
   * Every real under-redaction of an address leaves that address's '@' in the
   * clear — that is what "the address survived" means. So the '@' characters
   * still present after stripping must not exceed the ones the legacy pattern
   * never covered in the first place. Redacting MORE only lowers the left-hand
   * side, so over-redaction can never fail this; only a leak can.
   *
   * Counting rather than substring-matching is deliberate. A substring probe
   * reports a false leak whenever the same '@domain' text also occurs somewhere
   * the legacy pattern never matched (an '@' with no local part, say), which on
   * an @-dense alphabet is most inputs.
   *
   * Excess local-part beyond RFC 5321's 64 octets is ALLOWED to survive — the
   * one disclosed divergence — and carries no '@', so it does not register here.
   */
  const leaksAddress = (value: string): boolean => {
    let coveredAts = 0;
    for (const match of value.matchAll(LEGACY_EMAIL_PATTERN())) coveredAts += count(match[0], '@');
    return count(strip(value), '@') > count(value, '@') - coveredAts;
  };

  // Deterministic xorshift32 so a failure is reproducible from the seed alone.
  const makeRng = (seed: number) => () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 0x100000000;
  };

  const ALPHABETS: Record<string, string[]> = {
    'local-part+@': '@aZ09._%+-'.split(''),
    'alnum-heavy': 'aaaAAA000zZ9@.'.split(''),
    'dot-dash-heavy': '..--@aA0_%+'.split(''),
    'email-ish': ['user', 'jane.doe', 'bob', '@', 'example', '.com', '.edu', '.', ' ', '-', '_', 'x', 'ALLCAPS', '123'],
    'whitespace/unicode': '@aA0.- \t\né中_%+'.split(''),
    'long-token': ['x'.repeat(70), 'y'.repeat(30), '@', '.com', '.', '-', '_', ' ', 'a'],
    'at-dense': ['@', '.co', '.', 'a', '@@', 'x', '-', '_'],
  };

  // 20k per alphabet keeps this a few seconds in CI. The full sweep run when
  // this landed was 982,500 cases over these same seven alphabets plus the
  // targeted sweeps below, with zero leaks.
  it.each(Object.keys(ALPHABETS))('never leaks an address it used to redact — %s', (name) => {
    const alphabet = ALPHABETS[name];
    const rng = makeRng(0x2346beef);
    const leaks: string[] = [];
    for (let n = 0; n < 20_000; n += 1) {
      const length = 1 + Math.floor(rng() * 60);
      let input = '';
      for (let i = 0; i < length; i += 1) input += alphabet[Math.floor(rng() * alphabet.length)];
      if (leaksAddress(input)) leaks.push(input);
    }
    expect(leaks).toEqual([]);
  });

  it('never leaks across local-part lengths 1..400 for several domain shapes', () => {
    const leaks: string[] = [];
    for (let localPart = 1; localPart <= 400; localPart += 1) {
      for (const domain of ['mail.example.com', `${'a'.repeat(300)}.example.com`, 'x.y.z.co']) {
        const input = `send to ${'x'.repeat(localPart)}@${domain} now`;
        if (leaksAddress(input)) leaks.push(input.slice(0, 60));
      }
    }
    expect(leaks).toEqual([]);
  });

  it('never leaks across domain lengths 1..900', () => {
    const leaks: string[] = [];
    for (let domain = 1; domain <= 900; domain += 1) {
      const input = `mail user@${'a'.repeat(domain)}.example.com end`;
      if (leaksAddress(input)) leaks.push(input.slice(0, 60));
    }
    expect(leaks).toEqual([]);
  });
});

describe('professional-education email redaction — regression pins', () => {
  // Both of these are failure modes of the two OBVIOUS ports of PR #2346's
  // browser fix. They were measured, not hypothesised, and each is the reason
  // this file does not simply bound the old regex's local-part quantifier.

  // Port A — keep the `\b`, bound the local part. A local-part run longer than
  // 64 characters cannot reach the '@' from the only offset `\b` permits, so
  // the pattern matches NOTHING and the whole address survives in the clear.
  it.each([65, 80, 300, 5000])(
    'still redacts the @ and the domain when the local-part run is %i characters',
    (length) => {
      const result = strip(`${'x'.repeat(length)}@mail.example.com`);
      expect(result).toContain('[EMAIL_REDACTED]');
      expect(result).not.toContain('mail.example.com');
      expect(result).not.toContain('@');
    },
  );

  // Port B — drop the `\b`, bound the local part. The scan starts earlier and
  // matches a SHORTER address, moving `lastIndex` so the longer address later
  // in the string is missed. This exact input leaked '@AA99Aaa90...' under that
  // variant.
  it('redacts a trailing address whose local part was consumed by an earlier match', () => {
    const result = strip('.@0zaZ00..AA@AA99Aaa90.aAA0AaAA.9aa.0.aZA');
    expect(result).not.toContain('@');
  });

  // The DOMAIN bound was tried in #2346 and reverted for this reason. Pinned
  // here so nobody "symmetrises" the two bounds in this file either.
  it.each([200, 300, 400, 2000])('redacts an address with a %i-character domain run', (length) => {
    const result = strip(`mail user@${'a'.repeat(length)}.example.com end`);
    expect(result).toContain('[EMAIL_REDACTED]');
    expect(result).not.toContain('@');
  });
});

describe('professional-education email redaction — precision', () => {
  it('redacts ordinary addresses and leaves surrounding prose intact', () => {
    expect(strip('contact jane.doe@example.com or bob@mail.example.org.')).toBe(
      'contact [EMAIL_REDACTED] or [EMAIL_REDACTED].',
    );
  });

  it('leaves text with no address untouched', () => {
    const input = 'Ethics Update 2026 — 4.0 credit hours, NASBA field Regulatory Ethics.';
    expect(strip(input)).toBe(input);
  });

  it('does not treat a bare @ or a domain without one as an address', () => {
    expect(strip('see @handle and example.com')).toBe('see @handle and example.com');
  });

  it('still redacts through the object walker, not just bare strings', () => {
    const result = stripProfessionalEducationPii({
      course_title: 'Ethics',
      notes: 'reach me at jane.doe@example.com',
    }) as Record<string, string>;
    expect(result.notes).toBe('reach me at [EMAIL_REDACTED]');
    expect(result.course_title).toBe('Ethics');
  });
});
