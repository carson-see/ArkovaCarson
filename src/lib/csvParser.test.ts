/**
 * CSV Parser Tests
 */

import { describe, it, expect } from 'vitest';
import {
  parseCsvString,
  isValidEmail,
  isValidFingerprint,
  autoDetectMapping,
  validateCsvRows,
  extractAnchorRecords,
} from './csvParser';

describe('csvParser', () => {
  describe('parseCsvString', () => {
    it('should parse simple CSV', () => {
      const csv = `name,value
row1,100
row2,200`;

      const result = parseCsvString(csv);

      expect(result.columns).toHaveLength(2);
      expect(result.columns[0].name).toBe('name');
      expect(result.columns[1].name).toBe('value');
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].data.name).toBe('row1');
      expect(result.rows[0].data.value).toBe('100');
    });

    it('should handle quoted fields', () => {
      const csv = `name,description
"Smith, John","A ""quoted"" value"`;

      const result = parseCsvString(csv);

      expect(result.rows[0].data.name).toBe('Smith, John');
      expect(result.rows[0].data.description).toBe('A "quoted" value');
    });

    it('should handle empty lines', () => {
      const csv = `name,value

row1,100

row2,200
`;

      const result = parseCsvString(csv);

      expect(result.rows).toHaveLength(2);
    });

    it('should handle Windows line endings', () => {
      const csv = "name,value\r\nrow1,100\r\nrow2,200";

      const result = parseCsvString(csv);

      expect(result.rows).toHaveLength(2);
    });

    it('should set sample values from first data row', () => {
      const csv = `fingerprint,filename
abc123,test.pdf
def456,other.doc`;

      const result = parseCsvString(csv);

      expect(result.columns[0].sample).toBe('abc123');
      expect(result.columns[1].sample).toBe('test.pdf');
    });

    it('should handle 500 rows without crashing', () => {
      // Generate 500 rows of data
      const header = 'fingerprint,filename,size,email';
      const rows = Array.from({ length: 500 }, (_, i) => {
        const fingerprint = 'a'.repeat(64);
        return `${fingerprint},file${i}.pdf,${1024 + i},user${i}@example.com`;
      });

      const csv = [header, ...rows].join('\n');

      const startTime = performance.now();
      const result = parseCsvString(csv);
      const endTime = performance.now();

      expect(result.rows).toHaveLength(500);
      expect(result.columns).toHaveLength(4);
      // Should complete in reasonable time (< 1 second)
      expect(endTime - startTime).toBeLessThan(1000);
    });

    it('should handle 1000 rows', () => {
      const header = 'fingerprint,filename';
      const rows = Array.from({ length: 1000 }, (_, i) => {
        const fingerprint = 'b'.repeat(64);
        return `${fingerprint},document${i}.pdf`;
      });

      const csv = [header, ...rows].join('\n');
      const result = parseCsvString(csv);

      expect(result.rows).toHaveLength(1000);
      expect(result.totalRows).toBe(1000);
    });
  });

  describe('isValidEmail', () => {
    it('should accept valid emails', () => {
      expect(isValidEmail('user@example.com')).toBe(true);
      expect(isValidEmail('user.name@domain.co.uk')).toBe(true);
      expect(isValidEmail('user+tag@example.org')).toBe(true);
    });

    it('should reject invalid emails', () => {
      expect(isValidEmail('invalid')).toBe(false);
      expect(isValidEmail('invalid@')).toBe(false);
      expect(isValidEmail('@example.com')).toBe(false);
      expect(isValidEmail('user @example.com')).toBe(false);
      expect(isValidEmail('')).toBe(false);
    });
  });

  describe('isValidFingerprint', () => {
    it('should accept valid SHA-256 hex strings', () => {
      const validFingerprint = 'a'.repeat(64);
      expect(isValidFingerprint(validFingerprint)).toBe(true);

      const mixedCase = 'aAbBcCdDeEfF' + '1234567890'.repeat(5) + '12';
      expect(isValidFingerprint(mixedCase)).toBe(true);
    });

    it('should reject invalid fingerprints', () => {
      expect(isValidFingerprint('short')).toBe(false);
      expect(isValidFingerprint('a'.repeat(63))).toBe(false);
      expect(isValidFingerprint('a'.repeat(65))).toBe(false);
      expect(isValidFingerprint('g'.repeat(64))).toBe(false); // invalid hex char
      expect(isValidFingerprint('')).toBe(false);
    });
  });

  describe('autoDetectMapping', () => {
    it('should detect fingerprint column', () => {
      const columns = [
        { index: 0, name: 'fingerprint', sample: '' },
        { index: 1, name: 'filename', sample: '' },
      ];

      const mapping = autoDetectMapping(columns);

      expect(mapping.fingerprint).toBe(0);
      expect(mapping.filename).toBe(1);
    });

    it('should detect hash as fingerprint', () => {
      const columns = [
        { index: 0, name: 'sha256', sample: '' },
        { index: 1, name: 'file', sample: '' },
      ];

      const mapping = autoDetectMapping(columns);

      expect(mapping.fingerprint).toBe(0);
      expect(mapping.filename).toBe(1);
    });

    it('should detect email and size columns', () => {
      const columns = [
        { index: 0, name: 'fingerprint', sample: '' },
        { index: 1, name: 'filename', sample: '' },
        { index: 2, name: 'file_size', sample: '' },
        { index: 3, name: 'user_email', sample: '' },
      ];

      const mapping = autoDetectMapping(columns);

      expect(mapping.fileSize).toBe(2);
      expect(mapping.email).toBe(3);
    });

    it('should detect credential_type and metadata columns', () => {
      const columns = [
        { index: 0, name: 'fingerprint', sample: '' },
        { index: 1, name: 'filename', sample: '' },
        { index: 2, name: 'credential_type', sample: '' },
        { index: 3, name: 'metadata', sample: '' },
      ];

      const mapping = autoDetectMapping(columns);

      expect(mapping.credentialType).toBe(2);
      expect(mapping.metadata).toBe(3);
    });

    it('should detect credentialType as credential type column', () => {
      const columns = [
        { index: 0, name: 'fingerprint', sample: '' },
        { index: 1, name: 'filename', sample: '' },
        { index: 2, name: 'credentialType', sample: '' },
      ];

      const mapping = autoDetectMapping(columns);

      expect(mapping.credentialType).toBe(2);
    });

    it('should NOT map "Last Name" or "First Name" to filename', () => {
      const columns = [
        { index: 0, name: 'First Name', sample: 'Alice' },
        { index: 1, name: 'Last Name', sample: 'Smith' },
        { index: 2, name: 'Degree', sample: 'BS' },
        { index: 3, name: 'Major', sample: 'Computer Science' },
        { index: 4, name: 'GPA', sample: '3.8' },
      ];

      const mapping = autoDetectMapping(columns);

      // None of these columns should be auto-mapped
      expect(mapping.fingerprint).toBeNull();
      expect(mapping.filename).toBeNull();
      expect(mapping.fileSize).toBeNull();
      expect(mapping.email).toBeNull();
      expect(mapping.credentialType).toBeNull();
      expect(mapping.metadata).toBeNull();
    });
  });

  describe('validateCsvRows', () => {
    const columns = [
      { index: 0, name: 'fingerprint', sample: '' },
      { index: 1, name: 'filename', sample: '' },
      { index: 2, name: 'email', sample: '' },
    ];

    const mapping = {
      fingerprint: 0,
      filename: 1,
      fileSize: null,
      email: 2,
      credentialType: null,
      metadata: null,
    };

    it('should validate valid rows', () => {
      const rows = [
        {
          rowNumber: 2,
          data: {
            fingerprint: 'a'.repeat(64),
            filename: 'test.pdf',
            email: 'user@example.com',
          },
        },
      ];

      const result = validateCsvRows(rows, columns, mapping);

      expect(result.valid).toHaveLength(1);
      expect(result.invalid).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should identify invalid emails', () => {
      const rows = [
        {
          rowNumber: 2,
          data: {
            fingerprint: 'a'.repeat(64),
            filename: 'test.pdf',
            email: 'invalid-email',
          },
        },
      ];

      const result = validateCsvRows(rows, columns, mapping);

      expect(result.valid).toHaveLength(0);
      expect(result.invalid).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('Invalid email');
    });

    it('should allow empty fingerprints (auto-generated later)', () => {
      const rows = [
        {
          rowNumber: 2,
          data: {
            fingerprint: '',
            filename: 'test.pdf',
            email: '',
          },
        },
      ];

      const result = validateCsvRows(rows, columns, mapping);

      expect(result.valid).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
    });

    it('should identify invalid fingerprint format', () => {
      const rows = [
        {
          rowNumber: 2,
          data: {
            fingerprint: 'too-short',
            filename: 'test.pdf',
            email: '',
          },
        },
      ];

      const result = validateCsvRows(rows, columns, mapping);

      expect(result.invalid).toHaveLength(1);
      expect(result.errors[0].message).toContain('Invalid fingerprint');
    });

    it('should handle 500 rows validation', () => {
      const rows = Array.from({ length: 500 }, (_, i) => ({
        rowNumber: i + 2,
        data: {
          fingerprint: 'a'.repeat(64),
          filename: `file${i}.pdf`,
          email: `user${i}@example.com`,
        },
      }));

      const startTime = performance.now();
      const result = validateCsvRows(rows, columns, mapping);
      const endTime = performance.now();

      expect(result.valid).toHaveLength(500);
      expect(endTime - startTime).toBeLessThan(1000);
    });

    it('should validate credential type values', () => {
      const cols = [
        { index: 0, name: 'fingerprint', sample: '' },
        { index: 1, name: 'filename', sample: '' },
        { index: 2, name: 'credential_type', sample: '' },
      ];

      const m = {
        fingerprint: 0,
        filename: 1,
        fileSize: null,
        email: null,
        credentialType: 2,
        metadata: null,
      };

      const rows = [
        {
          rowNumber: 2,
          data: {
            fingerprint: 'a'.repeat(64),
            filename: 'test.pdf',
            credential_type: 'DEGREE',
          },
        },
        {
          rowNumber: 3,
          data: {
            fingerprint: 'b'.repeat(64),
            filename: 'test2.pdf',
            credential_type: 'INVALID_TYPE',
          },
        },
      ];

      const result = validateCsvRows(rows, cols, m);

      expect(result.valid).toHaveLength(1);
      expect(result.invalid).toHaveLength(1);
      expect(result.errors[0].message).toContain('Invalid credential type');
    });

    it('should validate metadata as valid JSON object', () => {
      const cols = [
        { index: 0, name: 'fingerprint', sample: '' },
        { index: 1, name: 'filename', sample: '' },
        { index: 2, name: 'metadata', sample: '' },
      ];

      const m = {
        fingerprint: 0,
        filename: 1,
        fileSize: null,
        email: null,
        credentialType: null,
        metadata: 2,
      };

      const rows = [
        {
          rowNumber: 2,
          data: {
            fingerprint: 'a'.repeat(64),
            filename: 'valid.pdf',
            metadata: '{"issuer": "MIT"}',
          },
        },
        {
          rowNumber: 3,
          data: {
            fingerprint: 'b'.repeat(64),
            filename: 'invalid-json.pdf',
            metadata: 'not-json',
          },
        },
        {
          rowNumber: 4,
          data: {
            fingerprint: 'c'.repeat(64),
            filename: 'array.pdf',
            metadata: '["array"]',
          },
        },
      ];

      const result = validateCsvRows(rows, cols, m);

      expect(result.valid).toHaveLength(1);
      expect(result.invalid).toHaveLength(2);
      expect(result.errors[0].message).toContain('valid JSON');
      expect(result.errors[1].message).toContain('JSON object');
    });

    it('should catch mixed valid and invalid rows', () => {
      const rows = [
        {
          rowNumber: 2,
          data: {
            fingerprint: 'a'.repeat(64),
            filename: 'valid.pdf',
            email: 'valid@example.com',
          },
        },
        {
          rowNumber: 3,
          data: {
            fingerprint: 'b'.repeat(64),
            filename: 'another.pdf',
            email: 'bad-email',
          },
        },
        {
          rowNumber: 4,
          data: {
            fingerprint: 'c'.repeat(64),
            filename: 'third.pdf',
            email: '',
          },
        },
      ];

      const result = validateCsvRows(rows, columns, mapping);

      expect(result.valid).toHaveLength(2);
      expect(result.invalid).toHaveLength(1);
      expect(result.errors[0].row).toBe(3);
    });
  });

  describe('extractAnchorRecords', () => {
    it('should extract anchor records from valid rows', () => {
      const columns = [
        { index: 0, name: 'fingerprint', sample: '' },
        { index: 1, name: 'filename', sample: '' },
        { index: 2, name: 'size', sample: '' },
      ];

      const mapping = {
        fingerprint: 0,
        filename: 1,
        fileSize: 2,
        email: null,
        credentialType: null,
        metadata: null,
      };

      const rows = [
        {
          rowNumber: 2,
          data: {
            fingerprint: 'A'.repeat(64),
            filename: 'Test.PDF',
            size: '1024',
          },
        },
      ];

      const records = extractAnchorRecords(rows, columns, mapping);

      expect(records).toHaveLength(1);
      expect(records[0].fingerprint).toBe('a'.repeat(64)); // lowercase
      expect(records[0].filename).toBe('Test.PDF');
      expect(records[0].fileSize).toBe(1024);
    });

    it('should extract credential type and metadata', () => {
      const columns = [
        { index: 0, name: 'fingerprint', sample: '' },
        { index: 1, name: 'filename', sample: '' },
        { index: 2, name: 'credential_type', sample: '' },
        { index: 3, name: 'metadata', sample: '' },
      ];

      const mapping = {
        fingerprint: 0,
        filename: 1,
        fileSize: null,
        email: null,
        credentialType: 2,
        metadata: 3,
      };

      const rows = [
        {
          rowNumber: 2,
          data: {
            fingerprint: 'A'.repeat(64),
            filename: 'degree.pdf',
            credential_type: 'degree',
            metadata: '{"issuer": "MIT", "program": "CS"}',
          },
        },
      ];

      const records = extractAnchorRecords(rows, columns, mapping);

      expect(records).toHaveLength(1);
      expect(records[0].credentialType).toBe('DEGREE');
      expect(records[0].metadata).toEqual({ issuer: 'MIT', program: 'CS' });
    });
  });
});
