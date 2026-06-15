/**
 * cleMetadataView tests (SCRUM-1869 / CLE-R1)
 *
 * Verifies the raw -> CleMetadataView mapping and, critically:
 *  - internal extraction signals never survive the conversion,
 *  - ethics_hours is first-class (preserved exactly, never defaulted to 0),
 *  - null ethics_hours forces requires_manual_review = true.
 */

import { describe, it, expect } from 'vitest';
import { extractCleMetadataView } from './cleMetadataView';

const RAW = {
  credit_hours: 6,
  ethics_hours: 2,
  jurisdiction: 'CA',
  delivery_format: 'On-Demand',
  approved_provider_name: 'Practising Law Institute',
  provider_approval_status: 'approved',
  provider_lookup_date: '2026-05-20',
  course_id: 'PLI-2026-0481',
  reporting_period_start: '2026-01-01',
  reporting_period_end: '2026-12-31',
  extraction_confidence: 0.97,
  extraction_source: 'ai',
  requires_manual_review: false,
};

describe('extractCleMetadataView', () => {
  it('returns null for null / non-object input', () => {
    expect(extractCleMetadataView(null)).toBeNull();
    expect(extractCleMetadataView(undefined)).toBeNull();
  });

  it('returns null when no meaningful CLE content is present', () => {
    expect(extractCleMetadataView({ unrelated: 'x' })).toBeNull();
  });

  it('maps the core CLE fields', () => {
    const view = extractCleMetadataView(RAW);
    expect(view).not.toBeNull();
    expect(view!.credit_hours).toBe(6);
    expect(view!.ethics_hours).toBe(2);
    expect(view!.jurisdiction).toBe('CA');
    expect(view!.delivery_format).toBe('On-Demand');
    expect(view!.provider_approval_status).toBe('approved');
    expect(view!.approved_provider_name).toBe('Practising Law Institute');
    expect(view!.requires_manual_review).toBe(false);
  });

  it('NEVER carries extraction_confidence or extraction_source across', () => {
    const view = extractCleMetadataView(RAW) as Record<string, unknown>;
    expect(view.extraction_confidence).toBeUndefined();
    expect(view.extraction_source).toBeUndefined();
    // And the serialized form contains neither the value nor the keys.
    const json = JSON.stringify(view);
    expect(json).not.toContain('0.97');
    expect(json).not.toContain('extraction_confidence');
    expect(json).not.toContain('extraction_source');
  });

  describe('ethics_hours is first-class', () => {
    it('preserves a present ethics_hours value exactly (incl. zero)', () => {
      // A genuine extracted 0 is preserved as 0 — distinct from "unconfirmed".
      const view = extractCleMetadataView({ ...RAW, ethics_hours: 0 });
      expect(view!.ethics_hours).toBe(0);
    });

    it('preserves a fractional ethics_hours value', () => {
      const view = extractCleMetadataView({ ...RAW, ethics_hours: 1.5 });
      expect(view!.ethics_hours).toBe(1.5);
    });

    it('keeps null ethics_hours as null — never defaults it to 0', () => {
      const view = extractCleMetadataView({ ...RAW, ethics_hours: null });
      expect(view!.ethics_hours).toBeNull();
      expect(view!.ethics_hours).not.toBe(0);
    });

    it('keeps a missing ethics_hours as null', () => {
      const { ethics_hours: _omit, ...withoutEthics } = RAW;
      const view = extractCleMetadataView(withoutEthics);
      expect(view!.ethics_hours).toBeNull();
    });

    it('forces requires_manual_review = true when ethics_hours is null', () => {
      // Even though the raw flag says false, a null ethics value must escalate.
      const view = extractCleMetadataView({ ...RAW, ethics_hours: null, requires_manual_review: false });
      expect(view!.requires_manual_review).toBe(true);
    });

    it('does NOT force review when ethics_hours is a confirmed number', () => {
      const view = extractCleMetadataView({ ...RAW, ethics_hours: 2, requires_manual_review: false });
      expect(view!.requires_manual_review).toBe(false);
    });
  });

  describe('jurisdiction normalization', () => {
    it('accepts the ISO-style US-XX form and returns the bare state code', () => {
      const view = extractCleMetadataView({ ...RAW, jurisdiction: 'US-NY' });
      expect(view!.jurisdiction).toBe('NY');
    });

    it('drops an unrecognized jurisdiction value', () => {
      const view = extractCleMetadataView({ ...RAW, jurisdiction: 'ZZ' });
      expect(view!.jurisdiction).toBeNull();
    });
  });

  it('drops an invalid provider_approval_status value', () => {
    const view = extractCleMetadataView({ ...RAW, provider_approval_status: 'bogus' });
    expect(view!.provider_approval_status).toBeNull();
  });

  it('merges anchor-derived display extras (course_title/completion/evidence)', () => {
    const view = extractCleMetadataView(RAW, {
      course_title: 'Advanced Trial Advocacy',
      completion_date: '2026-05-18',
      evidence_level: 'ai_captured',
    });
    expect(view!.course_title).toBe('Advanced Trial Advocacy');
    expect(view!.completion_date).toBe('2026-05-18');
    expect(view!.evidence_level).toBe('ai_captured');
  });

  it('treats requires_manual_review=true alone as meaningful content', () => {
    const view = extractCleMetadataView({ requires_manual_review: true });
    expect(view).not.toBeNull();
    expect(view!.requires_manual_review).toBe(true);
  });
});
