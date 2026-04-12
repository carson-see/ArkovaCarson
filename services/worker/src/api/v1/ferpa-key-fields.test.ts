import { describe, it, expect } from 'vitest';
import { z } from 'zod';

/**
 * Tests for FERPA requester identity fields on API key provisioning (REG-04 / SCRUM-568).
 * Validates the schema accepts FERPA fields and rejects invalid values.
 */

const FERPA_EXCEPTION_CATEGORIES = [
  '99.31(a)(1)', '99.31(a)(2)', '99.31(a)(3)', '99.31(a)(4)',
  '99.31(a)(5)', '99.31(a)(6)', '99.31(a)(7)', '99.31(a)(8)',
  '99.31(a)(9)', '99.31(a)(10)', '99.31(a)(11)', '99.31(a)(12)',
  'other', 'not_applicable',
] as const;

const INSTITUTION_TYPES = [
  'k12_school', 'university', 'community_college',
  'employer', 'government', 'accreditor', 'financial_aid',
  'research', 'legal', 'healthcare', 'other',
] as const;

const CreateKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).default(['verify']),
  expires_in_days: z.number().int().positive().optional(),
  ferpa_exception_category: z.enum(FERPA_EXCEPTION_CATEGORIES).optional(),
  institution_type: z.enum(INSTITUTION_TYPES).optional(),
  access_purpose: z.string().max(500).optional(),
});

describe('REG-04: FERPA API Key Fields', () => {
  it('accepts key creation without FERPA fields', () => {
    const result = CreateKeySchema.safeParse({ name: 'Test Key' });
    expect(result.success).toBe(true);
  });

  it('accepts valid FERPA exception category', () => {
    const result = CreateKeySchema.safeParse({
      name: 'University Transfer Key',
      ferpa_exception_category: '99.31(a)(2)',
      institution_type: 'university',
      access_purpose: 'Enrollment verification for transfer students',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ferpa_exception_category).toBe('99.31(a)(2)');
      expect(result.data.institution_type).toBe('university');
    }
  });

  it('rejects invalid FERPA exception category', () => {
    const result = CreateKeySchema.safeParse({
      name: 'Bad Key',
      ferpa_exception_category: 'invalid_category',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid institution type', () => {
    const result = CreateKeySchema.safeParse({
      name: 'Bad Key',
      institution_type: 'invalid_type',
    });
    expect(result.success).toBe(false);
  });

  it('accepts all 12 FERPA exception categories', () => {
    for (const category of FERPA_EXCEPTION_CATEGORIES) {
      const result = CreateKeySchema.safeParse({
        name: `Key for ${category}`,
        ferpa_exception_category: category,
      });
      expect(result.success).toBe(true);
    }
  });

  it('accepts all institution types', () => {
    for (const type of INSTITUTION_TYPES) {
      const result = CreateKeySchema.safeParse({
        name: `Key for ${type}`,
        institution_type: type,
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects access_purpose over 500 chars', () => {
    const result = CreateKeySchema.safeParse({
      name: 'Key',
      access_purpose: 'x'.repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it('accepts school_official with legitimate_educational_interest pattern', () => {
    const result = CreateKeySchema.safeParse({
      name: 'Registrar Access Key',
      ferpa_exception_category: '99.31(a)(1)',
      institution_type: 'university',
      access_purpose: 'As school official under DUA with legitimate educational interest in verifying student enrollment status',
    });
    expect(result.success).toBe(true);
  });
});
