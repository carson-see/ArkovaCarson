/**
 * Grounding Verification Tests (CRIT-5 / GAP-3)
 *
 * Tests that AI-extracted fields are cross-checked against source text
 * and hallucinated values are penalized.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock logger to avoid config dependency
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { verifyGrounding } from '../grounding.js';

describe('verifyGrounding', () => {
  const sampleText = `
    University of Michigan
    College of Engineering
    Bachelor of Science in Computer Science
    Awarded to [NAME_REDACTED]
    Date: May 15, 2024
    GPA: 3.85
    License Number: TX-PE-89012
    Accredited by ABET
    State of Texas, USA
  `;

  it('should ground fields that appear in source text', () => {
    const fields = {
      issuerName: 'University of Michigan',
      fieldOfStudy: 'Computer Science',
      degreeLevel: 'Bachelor of Science',
      jurisdiction: 'Texas, USA',
      licenseNumber: 'TX-PE-89012',
    };

    const report = verifyGrounding(fields, sampleText);

    expect(report.groundingScore).toBe(1.0);
    expect(report.confidenceAdjustment).toBe(0);
    expect(report.fieldResults.every((r) => r.grounded)).toBe(true);
  });

  it('should detect hallucinated fields not in source text', () => {
    const fields = {
      issuerName: 'Stanford Medical School', // NOT in source text at all
      fieldOfStudy: 'Quantum Physics', // NOT in source text
      degreeLevel: 'Doctor of Philosophy', // NOT in source text
    };

    const report = verifyGrounding(fields, sampleText);

    expect(report.groundingScore).toBeLessThan(1.0);
    expect(report.confidenceAdjustment).toBeLessThan(0);

    const stanfordResult = report.fieldResults.find((r) => r.field === 'issuerName');
    expect(stanfordResult?.grounded).toBe(false);
    expect(stanfordResult?.matchType).toBe('not_found');
  });

  it('should apply -0.3 penalty when <50% fields are grounded', () => {
    const fields = {
      issuerName: 'Completely Fabricated University',
      fieldOfStudy: 'Quantum Basket Weaving',
      degreeLevel: 'Doctorate of Nothing',
      jurisdiction: 'Narnia',
    };

    const report = verifyGrounding(fields, sampleText);

    expect(report.groundingScore).toBeLessThan(0.5);
    expect(report.confidenceAdjustment).toBe(-0.3);
  });

  it('should handle date format variations (ISO vs numeric display)', () => {
    // Source text with numeric date format that the variant matching can find
    const numericDateSource = 'Issued: 05/15/2024\nUniversity of Michigan';
    const fields = {
      issuedDate: '2024-05-15', // ISO format
    };

    const report = verifyGrounding(fields, numericDateSource);

    const dateResult = report.fieldResults.find((r) => r.field === 'issuedDate');
    expect(dateResult?.grounded).toBe(true);
    expect(dateResult?.matchType).toBe('normalized');
  });

  it('should skip non-groundable fields (confidence, fraudSignals, creditHours)', () => {
    const fields = {
      issuerName: 'University of Michigan',
      confidence: 0.95,
      fraudSignals: ['DUPLICATE_FINGERPRINT'],
      creditHours: 3,
    };

    const report = verifyGrounding(fields, sampleText);

    // Only issuerName should be checked
    expect(report.groundableFieldCount).toBe(1);
    expect(report.groundedFieldCount).toBe(1);
  });

  it('should skip redacted values', () => {
    const fields = {
      issuerName: 'University of Michigan',
      recipientIdentifier: '[NAME_REDACTED]',
    };

    const report = verifyGrounding(fields, sampleText);

    // Only issuerName should be checked (redacted values skipped)
    expect(report.groundableFieldCount).toBe(1);
  });

  it('should handle empty extracted fields gracefully', () => {
    const report = verifyGrounding({}, sampleText);

    expect(report.groundingScore).toBe(1.0);
    expect(report.confidenceAdjustment).toBe(0);
    expect(report.fieldResults).toHaveLength(0);
  });

  it('should handle empty source text', () => {
    const fields = { issuerName: 'Test University' };
    const report = verifyGrounding(fields, '');

    expect(report.groundingScore).toBe(0);
    expect(report.confidenceAdjustment).toBe(-0.3);
  });

  it('should use normalized matching for case differences and whitespace', () => {
    const fields = {
      issuerName: 'university of michigan', // lowercase
      accreditingBody: 'ABET', // uppercase
    };

    const report = verifyGrounding(fields, sampleText);

    expect(report.fieldResults.every((r) => r.grounded)).toBe(true);
  });

  it('should use fuzzy token matching for partial matches', () => {
    const fields = {
      issuerName: 'University of Michigan College of Engineering', // tokens all present
    };

    const report = verifyGrounding(fields, sampleText);

    const result = report.fieldResults.find((r) => r.field === 'issuerName');
    expect(result?.grounded).toBe(true);
  });

  it('should return correct report structure', () => {
    const fields = {
      issuerName: 'University of Michigan',
      fieldOfStudy: 'Computer Science',
      degreeLevel: 'Fabricated Degree', // hallucinated
    };

    const report = verifyGrounding(fields, sampleText);

    expect(report).toHaveProperty('fieldResults');
    expect(report).toHaveProperty('groundingScore');
    expect(report).toHaveProperty('groundableFieldCount');
    expect(report).toHaveProperty('groundedFieldCount');
    expect(report).toHaveProperty('confidenceAdjustment');
    expect(report.fieldResults).toBeInstanceOf(Array);
    expect(report.groundableFieldCount).toBe(3);
  });
});
