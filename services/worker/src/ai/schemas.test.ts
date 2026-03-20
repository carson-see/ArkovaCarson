/**
 * Tests for AI extraction Zod schemas (P8-S1)
 *
 * Validates input size limits and field validation on extraction requests.
 */

import { describe, it, expect } from 'vitest';
import { ExtractionRequestSchema, ExtractedFieldsSchema } from './schemas.js';

describe('ExtractionRequestSchema', () => {
  const validRequest = {
    strippedText: 'University of Michigan ... Bachelor of Science ...',
    credentialType: 'DEGREE',
    fingerprint: 'a'.repeat(64),
  };

  it('accepts a valid extraction request', () => {
    const result = ExtractionRequestSchema.safeParse(validRequest);
    expect(result.success).toBe(true);
  });

  it('rejects empty strippedText', () => {
    const result = ExtractionRequestSchema.safeParse({ ...validRequest, strippedText: '' });
    expect(result.success).toBe(false);
  });

  it('rejects strippedText exceeding 50,000 characters', () => {
    const result = ExtractionRequestSchema.safeParse({
      ...validRequest,
      strippedText: 'x'.repeat(50_001),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('50,000');
    }
  });

  it('accepts strippedText at exactly 50,000 characters', () => {
    const result = ExtractionRequestSchema.safeParse({
      ...validRequest,
      strippedText: 'x'.repeat(50_000),
    });
    expect(result.success).toBe(true);
  });

  it('rejects credentialType exceeding 50 characters', () => {
    const result = ExtractionRequestSchema.safeParse({
      ...validRequest,
      credentialType: 'A'.repeat(51),
    });
    expect(result.success).toBe(false);
  });

  it('rejects fingerprint of wrong length', () => {
    const result = ExtractionRequestSchema.safeParse({
      ...validRequest,
      fingerprint: 'abc',
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional issuerHint up to 200 chars', () => {
    const result = ExtractionRequestSchema.safeParse({
      ...validRequest,
      issuerHint: 'University of Michigan',
    });
    expect(result.success).toBe(true);
  });

  it('rejects issuerHint exceeding 200 characters', () => {
    const result = ExtractionRequestSchema.safeParse({
      ...validRequest,
      issuerHint: 'A'.repeat(201),
    });
    expect(result.success).toBe(false);
  });
});

describe('ExtractedFieldsSchema', () => {
  it('accepts valid extracted fields', () => {
    const result = ExtractedFieldsSchema.safeParse({
      credentialType: 'DEGREE',
      issuerName: 'University of Michigan',
      issuedDate: '2024-05-15',
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty object (all fields optional)', () => {
    const result = ExtractedFieldsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects unknown fields (strict mode — hallucination guard)', () => {
    const result = ExtractedFieldsSchema.safeParse({
      credentialType: 'DEGREE',
      hallucinated_field: 'should not be here',
    });
    expect(result.success).toBe(false);
  });
});
