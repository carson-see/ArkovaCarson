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
      jurisdiction: 'Narnia', // NOT in source text
      expiryDate: '2099-12-31', // NOT in source text
    };

    const report = verifyGrounding(fields, sampleText);

    expect(report.groundingScore).toBeLessThan(1.0);
    expect(report.confidenceAdjustment).toBeLessThan(0);

    const stanfordResult = report.fieldResults.find((r) => r.field === 'issuerName');
    expect(stanfordResult?.grounded).toBe(false);
    expect(stanfordResult?.matchType).toBe('not_found');
  });

  it('should apply -0.15 penalty when <50% groundable fields are grounded', () => {
    const fields = {
      issuerName: 'Completely Fabricated University',
      jurisdiction: 'Narnia',
      issuedDate: '1999-01-01',
      expiryDate: '2000-01-01',
    };

    const report = verifyGrounding(fields, sampleText);

    expect(report.groundingScore).toBeLessThan(0.5);
    expect(report.confidenceAdjustment).toBe(-0.15);
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

  // ITER-5: model-authored narrative fields must NOT be grounding-checked.
  // reasoning / description / subType are written BY the model (chain-of-thought,
  // human-readable summary, taxonomy label) — they are never verbatim in the
  // source document, so grounding them false-flags legitimate documents and
  // deflates confidence. They must be treated like the already-non-groundable
  // inferred fields (fieldOfStudy, degreeLevel).

  it('AC1: should NOT deflate confidence for legit doc whose reasoning/description/subType are not verbatim in source', () => {
    const fields = {
      // Every FACTUAL field is verbatim-grounded in sampleText:
      issuerName: 'University of Michigan',
      licenseNumber: 'TX-PE-89012',
      // Model-authored narrative — none of these appear in the source text:
      reasoning:
        'Classified as an engineering degree because the document names the College of Engineering and a Bachelor of Science.',
      description:
        'A bachelor of science degree in computer science conferred to the recipient by a major public university.',
      subType: 'official_undergraduate',
    };

    const report = verifyGrounding(fields, sampleText);

    // Narrative fields are skipped — only the two factual fields are groundable.
    expect(report.groundableFieldCount).toBe(2);
    expect(report.groundedFieldCount).toBe(2);
    // No narrative field should appear in the per-field results at all.
    const checkedFields = report.fieldResults.map((r) => r.field);
    expect(checkedFields).not.toContain('reasoning');
    expect(checkedFields).not.toContain('description');
    expect(checkedFields).not.toContain('subType');
    // The whole point: confidence is NOT deflated by the narrative fields.
    expect(report.groundingScore).toBe(1.0);
    expect(report.confidenceAdjustment).toBe(0);
  });

  it('AC2: should STILL flag a hallucinated FACTUAL field even when narrative fields are present', () => {
    const fields = {
      issuerName: 'Fabricated Issuer University', // hallucinated factual claim — NOT in source
      expiryDate: '2099-12-31', // hallucinated factual claim — NOT in source
      // Narrative fields present alongside the hallucination must not mask it:
      reasoning: 'The classification reasoning narrative goes here and is not in the source.',
      description: 'A human-readable summary that is also absent from the source document.',
      subType: 'fabricated_subtype_label',
    };

    const report = verifyGrounding(fields, sampleText);

    // Only the two factual fields are groundable; both are hallucinated.
    expect(report.groundableFieldCount).toBe(2);
    expect(report.groundedFieldCount).toBe(0);
    expect(report.groundingScore).toBeLessThan(1.0);
    expect(report.confidenceAdjustment).toBeLessThan(0);

    const issuerResult = report.fieldResults.find((r) => r.field === 'issuerName');
    expect(issuerResult?.grounded).toBe(false);
    expect(issuerResult?.matchType).toBe('not_found');
  });

  it('AC3: existing grounding behavior on factual fields is unchanged when no narrative fields are present', () => {
    // Mirrors the original grounded-fields case: factual-only extraction still
    // grounds perfectly and applies no penalty (regression guard for the allowlist change).
    const fields = {
      issuerName: 'University of Michigan',
      jurisdiction: 'Texas, USA',
      licenseNumber: 'TX-PE-89012',
    };

    const report = verifyGrounding(fields, sampleText);

    expect(report.groundableFieldCount).toBe(3);
    expect(report.groundedFieldCount).toBe(3);
    expect(report.groundingScore).toBe(1.0);
    expect(report.confidenceAdjustment).toBe(0);
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
    expect(report.confidenceAdjustment).toBe(-0.15);
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
      fieldOfStudy: 'Computer Science', // non-groundable (inferred field)
      degreeLevel: 'Fabricated Degree', // non-groundable (inferred field)
    };

    const report = verifyGrounding(fields, sampleText);

    expect(report).toHaveProperty('fieldResults');
    expect(report).toHaveProperty('groundingScore');
    expect(report).toHaveProperty('groundableFieldCount');
    expect(report).toHaveProperty('groundedFieldCount');
    expect(report).toHaveProperty('confidenceAdjustment');
    expect(report.fieldResults).toBeInstanceOf(Array);
    // fieldOfStudy and degreeLevel are non-groundable, only issuerName is checked
    expect(report.groundableFieldCount).toBe(1);
  });
});
