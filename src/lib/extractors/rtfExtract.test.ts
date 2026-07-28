/**
 * Tests for rtfExtract.ts — the real RTF control-word stripper (F3).
 *
 * Constitution §1.6: this module is CLIENT-SIDE ONLY. See
 * `no-worker-import.test.ts` for the automated guard.
 */
import { describe, it, expect } from 'vitest';
import { extractTextFromRtf } from './rtfExtract';
import { SAMPLE_RTF } from './__fixtures__/textFixtures';

describe('extractTextFromRtf — real control-word stripping', () => {
  it('extracts real document content from a genuine RTF fixture', () => {
    const text = extractTextFromRtf(SAMPLE_RTF);

    expect(text).toContain('Letter of Intent');
    expect(text).toContain('Acme Corp');
    expect(text).toContain('Arkova');
    expect(text).toContain('Term: 12 months');
    expect(text).toContain('Renewal: automatic');
    expect(text).toContain('Signed,');
    expect(text).toContain('The Parties');
  });

  it('decodes a \\\'hh CP-1252 hex escape to the real Unicode character (right single quote)', () => {
    const text = extractTextFromRtf(SAMPLE_RTF);
    expect(text).toContain('Founder’s Letter of Intent');
  });

  it('maps the \\bullet named control word to a real bullet character', () => {
    const text = extractTextFromRtf(SAMPLE_RTF);
    expect(text).toContain('• Term: 12 months');
    expect(text).toContain('• Renewal: automatic');
  });

  it('decodes a \\uN Unicode escape and swallows its \\uc-declared ASCII fallback', () => {
    const text = extractTextFromRtf(SAMPLE_RTF);
    // U+2122 TRADE MARK SIGN, with the fallback "?" swallowed (not "?™" or "™?").
    expect(text).toContain('Trademark test: ™');
    expect(text).not.toContain('™?');
    expect(text).not.toContain('?™');
  });

  it('drops non-visible destinations (fonttbl / colortbl / generator) entirely', () => {
    const text = extractTextFromRtf(SAMPLE_RTF);
    expect(text).not.toContain('Helvetica');
    expect(text).not.toContain('Riched20');
    expect(text).not.toMatch(/red0|green0|blue0/);
  });

  it('produces no raw RTF control words in the output (the original garbage-output bug)', () => {
    const text = extractTextFromRtf(SAMPLE_RTF);
    expect(text).not.toMatch(/\\[a-z]+\d*/);
    expect(text).not.toContain('{');
    expect(text).not.toContain('}');
  });

  it('turns \\par into real paragraph breaks (multi-line output, not one run-on line)', () => {
    const text = extractTextFromRtf(SAMPLE_RTF);
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(6);
  });

  it('drops bold formatting control words (\\b / \\b0) with no visible artifact', () => {
    const text = extractTextFromRtf(SAMPLE_RTF);
    expect(text).not.toMatch(/\bb0?\b.*Acme/);
    expect(text).toContain('Acme Corp');
  });

  // ---------------------------------------------------------------------
  // Malformed / hostile input — must fail gracefully (never throw, never
  // hang: this is a pure forward-scanning state machine, i is monotonic).
  // ---------------------------------------------------------------------
  describe('malformed / hostile input', () => {
    it('does not throw on a truncated RTF document (unmatched braces)', () => {
      const truncated = String.raw`{\rtf1\ansi{\fonttbl{\f0 Helvetica`;
      expect(() => extractTextFromRtf(truncated)).not.toThrow();
    });

    it('does not throw on a dangling backslash at end of input', () => {
      expect(() => extractTextFromRtf('Some text\\')).not.toThrow();
    });

    it('does not throw on a dangling hex escape at end of input', () => {
      expect(() => extractTextFromRtf(String.raw`Some text\'`)).not.toThrow();
    });

    it('does not throw and terminates promptly on non-RTF garbage bytes', () => {
      const garbage = '\x00\x01\x02'.repeat(500) + '{{{{{{{{{{}}}}';
      const start = Date.now();
      expect(() => extractTextFromRtf(garbage)).not.toThrow();
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it('does not throw on deeply unbalanced closing braces', () => {
      expect(() => extractTextFromRtf('}}}}}}}}}} text }}}}}}}}}}')).not.toThrow();
    });

    it('returns an empty-ish string (not a crash) for an empty input', () => {
      expect(extractTextFromRtf('')).toBe('');
    });
  });
});
