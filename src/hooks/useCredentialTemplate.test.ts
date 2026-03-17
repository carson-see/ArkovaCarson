/**
 * useCredentialTemplate + parseTemplateFields Tests (UF-01 / AUDIT-12)
 */

import { describe, it, expect } from 'vitest';
import { parseTemplateFields } from './useCredentialTemplate';
import type { TemplateField } from './useCredentialTemplate';

describe('parseTemplateFields', () => {
  it('returns empty array for null input', () => {
    expect(parseTemplateFields(null)).toEqual([]);
    expect(parseTemplateFields(undefined)).toEqual([]);
  });

  it('returns empty array for non-object input', () => {
    expect(parseTemplateFields('string' as never)).toEqual([]);
    expect(parseTemplateFields(42 as never)).toEqual([]);
  });

  it('returns empty array when fields is not an array', () => {
    expect(parseTemplateFields({ fields: 'not-array' })).toEqual([]);
    expect(parseTemplateFields({ other: 'data' })).toEqual([]);
  });

  it('parses valid fields correctly', () => {
    const metadata = {
      fields: [
        { key: 'name', label: 'Full Name', type: 'text', required: true },
        { key: 'gpa', label: 'GPA', type: 'number' },
        { key: 'degree', label: 'Degree Type', type: 'select', options: ['BS', 'BA', 'MS', 'PhD'] },
      ],
    };

    const result = parseTemplateFields(metadata);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ key: 'name', label: 'Full Name', type: 'text', required: true, options: undefined });
    expect(result[2].options).toEqual(['BS', 'BA', 'MS', 'PhD']);
  });

  it('defaults type to text when missing', () => {
    const metadata = { fields: [{ key: 'note', label: 'Notes' }] };
    const result = parseTemplateFields(metadata);
    expect(result[0].type).toBe('text');
  });

  it('skips invalid field objects', () => {
    const metadata = {
      fields: [
        { key: 'valid', label: 'Valid Field' },
        { key: 123, label: 'Invalid Key' }, // key not string
        null,
        'not-an-object',
        { label: 'Missing Key' }, // no key
      ],
    };

    const result = parseTemplateFields(metadata);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('valid');
  });

  it('handles TemplateField type interface', () => {
    const field: TemplateField = {
      key: 'date',
      label: 'Issue Date',
      type: 'date',
      required: true,
    };
    expect(field.type).toBe('date');
    expect(field.options).toBeUndefined();
  });
});
