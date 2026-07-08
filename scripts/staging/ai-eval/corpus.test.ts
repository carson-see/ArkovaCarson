import { describe, it, expect } from 'vitest';

import {
  variantText,
  buildVariantCorpus,
  parseDocVariants,
  isLoadOnlyVariant,
  STRIPPED_TEXT_MAX,
  DOC_VARIANTS,
  EVAL_SCORABLE_VARIANTS,
} from './corpus.js';
import type { GoldenEntry } from './scoring.js';

const ENTRY: GoldenEntry = {
  id: 'GD-S3-CPE-001',
  description: 'clean CPE',
  strippedText: 'CPE Certificate. 8 credits. Issued 2026-01-05. Provider Acme Institute 100.',
  credentialTypeHint: 'CPE',
  groundTruth: { credentialType: 'CPE', creditHours: 8, issuedDate: '2026-01-05' },
  source: 'synthetic/s3-cpe-cle/cpe-001',
  category: 'professional-education',
  tags: ['synthetic', 's3-cpe-cle', 'cpe', 'clean'],
};

describe('variantText', () => {
  it('pdf-clean returns the base text unchanged', () => {
    expect(variantText(ENTRY, 'pdf-clean')).toBe(ENTRY.strippedText);
  });
  it('scan-ocr introduces OCR-style corruption (0→O, 1→l)', () => {
    const t = variantText(ENTRY, 'scan-ocr');
    expect(t).not.toBe(ENTRY.strippedText);
    expect(t).toContain('lOO'); // "100" → "lOO"
  });
  it('large pads near, but under, the 50k limit (stays scorable)', () => {
    const t = variantText(ENTRY, 'large');
    expect(t.length).toBeLessThan(STRIPPED_TEXT_MAX);
    expect(t.length).toBeGreaterThan(STRIPPED_TEXT_MAX - 500);
    expect(t.startsWith('CPE Certificate')).toBe(true); // real content leads
  });
  it('oversized pushes PAST the 50k limit so the endpoint must 400', () => {
    expect(variantText(ENTRY, 'oversized').length).toBeGreaterThan(STRIPPED_TEXT_MAX);
  });
  it('malformed yields short garbage (robustness probe)', () => {
    const t = variantText(ENTRY, 'malformed');
    expect(t).toContain('{"trunc":');
  });
});

describe('scorable vs load-only classification', () => {
  it('marks oversized/malformed as load-only (not eval-scored)', () => {
    expect(isLoadOnlyVariant('oversized')).toBe(true);
    expect(isLoadOnlyVariant('malformed')).toBe(true);
    expect(isLoadOnlyVariant('pdf-clean')).toBe(false);
  });
  it('keeps pdf/scan/docx/large in the eval-scorable set', () => {
    for (const v of ['pdf-clean', 'scan-ocr', 'docx-text', 'large'] as const) {
      expect(EVAL_SCORABLE_VARIANTS.has(v)).toBe(true);
    }
  });
});

describe('buildVariantCorpus', () => {
  it('expands entries × variants and marks scorability per item', () => {
    const corpus = buildVariantCorpus([ENTRY], [...DOC_VARIANTS]);
    expect(corpus).toHaveLength(DOC_VARIANTS.length);
    const oversized = corpus.find((c) => c.variant === 'oversized')!;
    expect(oversized.scorable).toBe(false);
    const pdf = corpus.find((c) => c.variant === 'pdf-clean')!;
    expect(pdf.scorable).toBe(true);
    expect(pdf.strippedText).toBe(ENTRY.strippedText);
  });
  it('throws on an empty corpus or empty variant list', () => {
    expect(() => buildVariantCorpus([], ['pdf-clean'])).toThrow();
    expect(() => buildVariantCorpus([ENTRY], [])).toThrow();
  });
});

describe('parseDocVariants', () => {
  it('defaults to all variants when unset', () => {
    expect(parseDocVariants(undefined)).toEqual([...DOC_VARIANTS]);
  });
  it('parses and canonically orders a subset', () => {
    expect(parseDocVariants('large,pdf-clean')).toEqual(['pdf-clean', 'large']);
  });
  it('throws on an all-unknown list', () => {
    expect(() => parseDocVariants('bogus')).toThrow();
  });
});
