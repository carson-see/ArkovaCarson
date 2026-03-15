/**
 * Unit tests for Zod validators
 */

import { describe, it, expect } from 'vitest';
import {
  AnchorCreateSchema,
  AnchorUpdateSchema,
  ProfileUpdateSchema,
  AuditEventCreateSchema,
  OrganizationUpdateSchema,
  validateAnchorCreate,
  validateProfileUpdate,
  normalizeFingerprint,
  isValidFilename,
  validateMetadataAgainstTemplate,
} from './validators';

describe('AnchorCreateSchema', () => {
  const validData = {
    fingerprint: 'a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd',
    filename: 'document.pdf',
    file_size: 1024,
    file_mime: 'application/pdf',
  };

  it('accepts valid anchor data', () => {
    const result = AnchorCreateSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it('normalizes fingerprint to lowercase', () => {
    const uppercaseData = {
      ...validData,
      fingerprint: 'A1B2C3D4E5F6789012345678901234567890123456789012345678901234ABCD',
    };
    const result = AnchorCreateSchema.parse(uppercaseData);
    expect(result.fingerprint).toBe(
      'a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd'
    );
  });

  it('rejects invalid fingerprint (too short)', () => {
    const result = AnchorCreateSchema.safeParse({
      ...validData,
      fingerprint: 'abc123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid fingerprint (non-hex)', () => {
    const result = AnchorCreateSchema.safeParse({
      ...validData,
      fingerprint: 'g1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd',
    });
    expect(result.success).toBe(false);
  });

  it('rejects filename with control characters', () => {
    const result = AnchorCreateSchema.safeParse({
      ...validData,
      filename: 'file\x00name.pdf',
    });
    expect(result.success).toBe(false);
  });

  it('rejects filename exceeding 255 characters', () => {
    const result = AnchorCreateSchema.safeParse({
      ...validData,
      filename: 'a'.repeat(256) + '.pdf',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty filename', () => {
    const result = AnchorCreateSchema.safeParse({
      ...validData,
      filename: '',
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional fields as null', () => {
    const result = AnchorCreateSchema.safeParse({
      fingerprint: validData.fingerprint,
      filename: validData.filename,
      file_size: null,
      file_mime: null,
      org_id: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects negative file size', () => {
    const result = AnchorCreateSchema.safeParse({
      ...validData,
      file_size: -100,
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid org_id format', () => {
    const result = AnchorCreateSchema.safeParse({
      ...validData,
      org_id: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });

  it('rejects array as metadata', () => {
    const result = AnchorCreateSchema.safeParse({
      ...validData,
      metadata: [1, 2, 3],
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid object as metadata', () => {
    const result = AnchorCreateSchema.safeParse({
      ...validData,
      metadata: { key: 'value', nested: { a: 1 } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid credential_type', () => {
    const result = AnchorCreateSchema.safeParse({
      ...validData,
      credential_type: 'INVALID_TYPE',
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid credential_type', () => {
    const result = AnchorCreateSchema.safeParse({
      ...validData,
      credential_type: 'DEGREE',
    });
    expect(result.success).toBe(true);
  });
});

describe('AnchorUpdateSchema', () => {
  it('accepts valid update data', () => {
    const result = AnchorUpdateSchema.safeParse({
      filename: 'new_name.pdf',
    });
    expect(result.success).toBe(true);
  });

  it('accepts partial updates', () => {
    const result = AnchorUpdateSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects filename with control characters', () => {
    const result = AnchorUpdateSchema.safeParse({
      filename: 'file\x1Fname.pdf',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid credential_type', () => {
    const result = AnchorUpdateSchema.safeParse({
      credential_type: 'INVALID_TYPE',
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid credential_type', () => {
    const result = AnchorUpdateSchema.safeParse({
      credential_type: 'LICENSE',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid retention_until datetime', () => {
    const result = AnchorUpdateSchema.safeParse({
      retention_until: '2027-01-01T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid retention_until', () => {
    const result = AnchorUpdateSchema.safeParse({
      retention_until: 'not-a-date',
    });
    expect(result.success).toBe(false);
  });

  it('accepts deleted_at datetime', () => {
    const result = AnchorUpdateSchema.safeParse({
      deleted_at: '2026-03-10T12:00:00Z',
    });
    expect(result.success).toBe(true);
  });
});

describe('ProfileUpdateSchema', () => {
  it('accepts valid profile update', () => {
    const result = ProfileUpdateSchema.safeParse({
      full_name: 'John Doe',
      avatar_url: 'https://example.com/avatar.png',
    });
    expect(result.success).toBe(true);
  });

  it('accepts null values', () => {
    const result = ProfileUpdateSchema.safeParse({
      full_name: null,
      avatar_url: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid avatar URL', () => {
    const result = ProfileUpdateSchema.safeParse({
      avatar_url: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  it('rejects full_name exceeding 255 characters', () => {
    const result = ProfileUpdateSchema.safeParse({
      full_name: 'a'.repeat(256),
    });
    expect(result.success).toBe(false);
  });
});

describe('AuditEventCreateSchema', () => {
  it('accepts valid audit event', () => {
    const result = AuditEventCreateSchema.safeParse({
      event_type: 'anchor.created',
      event_category: 'ANCHOR',
      target_type: 'anchor',
      target_id: '123e4567-e89b-12d3-a456-426614174000',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid event category', () => {
    const result = AuditEventCreateSchema.safeParse({
      event_type: 'test',
      event_category: 'INVALID',
    });
    expect(result.success).toBe(false);
  });

  it('accepts all valid categories', () => {
    const categories = ['AUTH', 'ANCHOR', 'PROFILE', 'ORG', 'ADMIN', 'SYSTEM'];
    for (const category of categories) {
      const result = AuditEventCreateSchema.safeParse({
        event_type: 'test',
        event_category: category,
      });
      expect(result.success).toBe(true);
    }
  });
});

describe('OrganizationUpdateSchema', () => {
  it('accepts valid organization update', () => {
    const result = OrganizationUpdateSchema.safeParse({
      display_name: 'New Name',
      domain: 'example.com',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid domain format', () => {
    const result = OrganizationUpdateSchema.safeParse({
      domain: 'UPPERCASE.COM',
    });
    expect(result.success).toBe(false);
  });

  it('rejects domain without TLD', () => {
    const result = OrganizationUpdateSchema.safeParse({
      domain: 'nodot',
    });
    expect(result.success).toBe(false);
  });
});

describe('validateAnchorCreate helper', () => {
  it('returns parsed data for valid input', () => {
    const data = {
      fingerprint: 'a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd',
      filename: 'test.pdf',
    };
    const result = validateAnchorCreate(data);
    expect(result.filename).toBe('test.pdf');
  });

  it('throws for invalid input', () => {
    expect(() =>
      validateAnchorCreate({ fingerprint: 'invalid', filename: '' })
    ).toThrow();
  });
});

describe('validateProfileUpdate helper', () => {
  it('returns parsed data for valid input', () => {
    const result = validateProfileUpdate({ full_name: 'Test' });
    expect(result.full_name).toBe('Test');
  });
});

describe('normalizeFingerprint helper', () => {
  it('normalizes valid fingerprint to lowercase', () => {
    const result = normalizeFingerprint(
      'A1B2C3D4E5F6789012345678901234567890123456789012345678901234ABCD'
    );
    expect(result).toBe(
      'a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd'
    );
  });

  it('returns null for invalid fingerprint', () => {
    expect(normalizeFingerprint('invalid')).toBeNull();
    expect(normalizeFingerprint('')).toBeNull();
    expect(normalizeFingerprint('abc')).toBeNull();
  });
});

describe('isValidFilename helper', () => {
  it('returns true for valid filename', () => {
    expect(isValidFilename('document.pdf')).toBe(true);
    expect(isValidFilename('my file (1).pdf')).toBe(true);
  });

  it('returns false for empty filename', () => {
    expect(isValidFilename('')).toBe(false);
  });

  it('returns false for filename with control characters', () => {
    expect(isValidFilename('file\x00.pdf')).toBe(false);
    expect(isValidFilename('file\x1F.pdf')).toBe(false);
    expect(isValidFilename('file\x7F.pdf')).toBe(false);
  });

  it('returns false for filename exceeding 255 characters', () => {
    expect(isValidFilename('a'.repeat(256))).toBe(false);
  });
});

// =============================================================================
// validateMetadataAgainstTemplate (UF-05)
// =============================================================================

describe('validateMetadataAgainstTemplate', () => {
  const fields = [
    { key: 'name', label: 'Name', type: 'text' as const, required: true },
    { key: 'gpa', label: 'GPA', type: 'number' as const, required: false },
    { key: 'grad_date', label: 'Graduation Date', type: 'date' as const, required: true },
    { key: 'level', label: 'Degree Level', type: 'select' as const, required: true, options: ['Bachelor', 'Master', 'Doctorate'] },
  ];

  it('returns empty map when all required fields are valid', () => {
    const values = { name: 'John', gpa: '3.5', grad_date: '2025-06-15', level: 'Bachelor' };
    expect(validateMetadataAgainstTemplate(values, fields)).toEqual({});
  });

  it('reports missing required text field', () => {
    const values = { name: '', gpa: '', grad_date: '2025-06-15', level: 'Master' };
    const errors = validateMetadataAgainstTemplate(values, fields);
    expect(errors.name).toBe('Name is required');
  });

  it('reports missing required select field', () => {
    const values = { name: 'Jane', grad_date: '2025-06-15', level: '' };
    const errors = validateMetadataAgainstTemplate(values, fields);
    expect(errors.level).toBe('Degree Level is required');
  });

  it('reports invalid number value', () => {
    const values = { name: 'Jane', gpa: 'abc', grad_date: '2025-06-15', level: 'Bachelor' };
    const errors = validateMetadataAgainstTemplate(values, fields);
    expect(errors.gpa).toBe('GPA must be a number');
  });

  it('reports invalid date value', () => {
    const values = { name: 'Jane', grad_date: 'not-a-date', level: 'Bachelor' };
    const errors = validateMetadataAgainstTemplate(values, fields);
    expect(errors.grad_date).toBe('Graduation Date must be a valid date');
  });

  it('reports invalid select value', () => {
    const values = { name: 'Jane', grad_date: '2025-06-15', level: 'Associate' };
    const errors = validateMetadataAgainstTemplate(values, fields);
    expect(errors.level).toBe('Degree Level must be one of: Bachelor, Master, Doctorate');
  });

  it('skips validation for empty optional fields', () => {
    const values = { name: 'Jane', gpa: '', grad_date: '2025-06-15', level: 'Bachelor' };
    expect(validateMetadataAgainstTemplate(values, fields)).toEqual({});
  });

  it('handles missing keys as empty strings', () => {
    const values = { grad_date: '2025-06-15', level: 'Master' };
    const errors = validateMetadataAgainstTemplate(values, fields);
    expect(errors.name).toBe('Name is required');
    expect(errors.gpa).toBeUndefined();
  });

  it('trims whitespace-only values as empty', () => {
    const values = { name: '   ', grad_date: '2025-06-15', level: 'Bachelor' };
    const errors = validateMetadataAgainstTemplate(values, fields);
    expect(errors.name).toBe('Name is required');
  });
});
