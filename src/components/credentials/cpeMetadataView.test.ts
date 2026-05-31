/**
 * cpeMetadataView tests (SCRUM-1847 / CPE-R1)
 *
 * Verifies the raw -> CpeMetadataView mapping and, critically, that internal
 * extraction signals never survive the conversion (SCRUM-1858).
 */

import { describe, it, expect } from 'vitest';
import { extractCpeMetadataView } from './cpeMetadataView';

const RAW = {
  credit_hours: 7,
  field_of_study: 'Information Technology',
  delivery_method: 'QAS Self-Study',
  nasba_status: 'confirmed',
  nasba_lookup_date: '2026-05-20',
  sponsor_id: '108297',
  reporting_period_start: '2026-01-01',
  reporting_period_end: '2026-12-31',
  extraction_confidence: 0.97,
  extraction_source: 'ai',
  requires_manual_review: false,
};

describe('extractCpeMetadataView', () => {
  it('returns null for null / non-object input', () => {
    expect(extractCpeMetadataView(null)).toBeNull();
    expect(extractCpeMetadataView(undefined)).toBeNull();
  });

  it('returns null when no meaningful CPE content is present', () => {
    expect(extractCpeMetadataView({ unrelated: 'x' })).toBeNull();
  });

  it('maps the core CPE fields', () => {
    const view = extractCpeMetadataView(RAW);
    expect(view).not.toBeNull();
    expect(view!.credit_hours).toBe(7);
    expect(view!.field_of_study).toBe('Information Technology');
    expect(view!.delivery_method).toBe('QAS Self-Study');
    expect(view!.nasba_status).toBe('confirmed');
    expect(view!.requires_manual_review).toBe(false);
  });

  it('NEVER carries extraction_confidence or extraction_source across', () => {
    const view = extractCpeMetadataView(RAW) as Record<string, unknown>;
    expect(view.extraction_confidence).toBeUndefined();
    expect(view.extraction_source).toBeUndefined();
    // And the serialized form contains neither the value nor the keys.
    const json = JSON.stringify(view);
    expect(json).not.toContain('0.97');
    expect(json).not.toContain('extraction_confidence');
    expect(json).not.toContain('extraction_source');
  });

  it('drops an invalid nasba_status value', () => {
    const view = extractCpeMetadataView({ ...RAW, nasba_status: 'bogus' });
    expect(view!.nasba_status).toBeNull();
  });

  it('merges anchor-derived display extras (provider/title/completion/evidence)', () => {
    const view = extractCpeMetadataView(RAW, {
      provider: 'Udemy',
      title: 'Advanced Cloud Security for CPAs',
      completion_date: '2026-05-18',
      evidence_level: 'ai_captured',
    });
    expect(view!.provider).toBe('Udemy');
    expect(view!.title).toBe('Advanced Cloud Security for CPAs');
    expect(view!.completion_date).toBe('2026-05-18');
    expect(view!.evidence_level).toBe('ai_captured');
  });

  it('treats requires_manual_review=true alone as meaningful content', () => {
    const view = extractCpeMetadataView({ requires_manual_review: true });
    expect(view).not.toBeNull();
    expect(view!.requires_manual_review).toBe(true);
  });
});
