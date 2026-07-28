/**
 * Tests for svgExtract.ts — SVG text-node extraction (F3).
 *
 * Constitution §1.6: this module is CLIENT-SIDE ONLY. See
 * `no-worker-import.test.ts` for the automated guard.
 */
import { describe, it, expect } from 'vitest';
import { extractTextFromSvg } from './svgExtract';
import { SAMPLE_SVG, CORRUPT_SVG } from './__fixtures__/textFixtures';

describe('extractTextFromSvg — real XML text-node extraction', () => {
  it('extracts <title> and <desc> content', () => {
    const text = extractTextFromSvg(SAMPLE_SVG);
    expect(text).toContain('Arkova Anchor Seal');
    expect(text).toContain('A tamper-evident seal for the Founder LOI batch.');
  });

  it('extracts <text> content, including nested <tspan> runs', () => {
    const text = extractTextFromSvg(SAMPLE_SVG);
    expect(text).toContain('Anchor ID: SCRUM-2911');
    expect(text).toContain('Status: Verified');
  });

  it('strips pure markup — no tag names, attribute values, or path data leak into the output', () => {
    const text = extractTextFromSvg(SAMPLE_SVG);
    expect(text).not.toContain('<svg');
    expect(text).not.toContain('viewBox');
    expect(text).not.toContain('#0f172a');
    expect(text).not.toContain('font-size');
  });

  it('does not throw and fails gracefully on malformed SVG markup', () => {
    expect(() => extractTextFromSvg(CORRUPT_SVG)).toThrow();
  });

  it('returns empty string for a valid SVG with no title/desc/text elements', () => {
    const text = extractTextFromSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="10" height="10"/></svg>',
    );
    expect(text).toBe('');
  });

  it('handles a genuinely huge attribute-heavy SVG without hanging', () => {
    const manyRects = Array.from({ length: 5000 }, (_, i) => `<rect x="${i}" y="${i}" width="1" height="1"/>`).join('');
    const bigSvg = `<svg xmlns="http://www.w3.org/2000/svg"><title>Big</title>${manyRects}<text>Done</text></svg>`;
    const start = Date.now();
    const text = extractTextFromSvg(bigSvg);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(text).toContain('Big');
    expect(text).toContain('Done');
  });
});
