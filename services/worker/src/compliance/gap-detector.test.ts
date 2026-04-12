/**
 * Gap Detector Tests (NCE-08)
 */

import { describe, it, expect } from 'vitest';
import { detectGaps, type GapDetectorInput } from './gap-detector.js';

const MOCK_RULES = [{
  id: 'r1',
  jurisdiction_code: 'US-CA',
  industry_code: 'accounting',
  rule_name: 'California CPA Requirements',
  required_credential_types: ['LICENSE', 'CERTIFICATE', 'CONTINUING_EDUCATION'],
  optional_credential_types: ['DEGREE'],
  regulatory_reference: 'CA Bus & Prof Code §5026',
  details: { ce_hours: 80, ce_cycle_years: 2 },
}];

describe('detectGaps', () => {
  it('returns all required types as missing when no anchors present', () => {
    const input: GapDetectorInput = {
      rules: MOCK_RULES,
      anchors: [],
      aggregateData: null,
    };
    const result = detectGaps(input);
    expect(result.missing_required).toHaveLength(3);
    expect(result.missing_required.map(m => m.type)).toEqual(['LICENSE', 'CONTINUING_EDUCATION', 'CERTIFICATE']);
    expect(result.summary).toContain('missing');
  });

  it('returns no gaps when all required documents present', () => {
    const input: GapDetectorInput = {
      rules: MOCK_RULES,
      anchors: [
        { id: 'a1', credential_type: 'LICENSE', status: 'SECURED' },
        { id: 'a2', credential_type: 'CERTIFICATE', status: 'SECURED' },
        { id: 'a3', credential_type: 'CONTINUING_EDUCATION', status: 'SECURED' },
      ],
      aggregateData: null,
    };
    const result = detectGaps(input);
    expect(result.missing_required).toHaveLength(0);
    expect(result.summary).toContain('all');
  });

  it('identifies partial gaps correctly', () => {
    const input: GapDetectorInput = {
      rules: MOCK_RULES,
      anchors: [
        { id: 'a1', credential_type: 'LICENSE', status: 'SECURED' },
      ],
      aggregateData: null,
    };
    const result = detectGaps(input);
    expect(result.missing_required).toHaveLength(2);
    expect(result.missing_required.map(m => m.type)).toContain('CERTIFICATE');
    expect(result.missing_required.map(m => m.type)).toContain('CONTINUING_EDUCATION');
  });

  it('includes recommended (optional) types not present', () => {
    const input: GapDetectorInput = {
      rules: MOCK_RULES,
      anchors: [
        { id: 'a1', credential_type: 'LICENSE', status: 'SECURED' },
        { id: 'a2', credential_type: 'CERTIFICATE', status: 'SECURED' },
        { id: 'a3', credential_type: 'CONTINUING_EDUCATION', status: 'SECURED' },
      ],
      aggregateData: null,
    };
    const result = detectGaps(input);
    expect(result.missing_recommended).toHaveLength(1);
    expect(result.missing_recommended[0].type).toBe('DEGREE');
  });

  it('includes aggregate data when provided', () => {
    const input: GapDetectorInput = {
      rules: MOCK_RULES,
      anchors: [],
      aggregateData: { LICENSE: 95, CERTIFICATE: 80, CONTINUING_EDUCATION: 70 },
    };
    const result = detectGaps(input);
    expect(result.missing_required[0].peer_adoption_pct).toBeDefined();
  });

  it('prioritizes missing docs by weight (LICENSE > CE > CERTIFICATE)', () => {
    const input: GapDetectorInput = {
      rules: MOCK_RULES,
      anchors: [],
      aggregateData: null,
    };
    const result = detectGaps(input);
    expect(result.priority_order[0]).toBe('LICENSE');
  });

  it('ignores non-SECURED anchors', () => {
    const input: GapDetectorInput = {
      rules: MOCK_RULES,
      anchors: [
        { id: 'a1', credential_type: 'LICENSE', status: 'PENDING' },
      ],
      aggregateData: null,
    };
    const result = detectGaps(input);
    expect(result.missing_required).toHaveLength(3);
  });
});
