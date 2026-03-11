/**
 * CSV Export Utility Tests
 */

import { describe, it, expect, vi } from 'vitest';
import {
  generateCsv,
  downloadCsv,
  formatDateForCsv,
  generateExportFilename,
} from './csvExport';

describe('csvExport', () => {
  describe('generateCsv', () => {
    it('should generate CSV from simple data', () => {
      const data = [
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 25 },
      ];

      const columns = [
        { header: 'Name', accessor: 'name' as const },
        { header: 'Age', accessor: 'age' as const },
      ];

      const result = generateCsv(data, columns);

      expect(result).toBe('Name,Age\nAlice,30\nBob,25');
    });

    it('should escape values with commas', () => {
      const data = [{ name: 'Smith, John', value: 100 }];
      const columns = [
        { header: 'Name', accessor: 'name' as const },
        { header: 'Value', accessor: 'value' as const },
      ];

      const result = generateCsv(data, columns);

      expect(result).toBe('Name,Value\n"Smith, John",100');
    });

    it('should escape values with quotes', () => {
      const data = [{ name: 'Say "Hello"', value: 50 }];
      const columns = [
        { header: 'Name', accessor: 'name' as const },
        { header: 'Value', accessor: 'value' as const },
      ];

      const result = generateCsv(data, columns);

      expect(result).toBe('Name,Value\n"Say ""Hello""",50');
    });

    it('should escape values with newlines', () => {
      const data = [{ name: 'Line1\nLine2', value: 75 }];
      const columns = [
        { header: 'Name', accessor: 'name' as const },
        { header: 'Value', accessor: 'value' as const },
      ];

      const result = generateCsv(data, columns);

      expect(result).toBe('Name,Value\n"Line1\nLine2",75');
    });

    it('should handle null and undefined values', () => {
      const data = [{ name: null, value: undefined }] as unknown as { name: string; value: number }[];
      const columns = [
        { header: 'Name', accessor: 'name' as const },
        { header: 'Value', accessor: 'value' as const },
      ];

      const result = generateCsv(data, columns);

      expect(result).toBe('Name,Value\n,');
    });

    it('should support function accessors', () => {
      const data = [
        { firstName: 'John', lastName: 'Doe' },
        { firstName: 'Jane', lastName: 'Smith' },
      ];

      const columns = [
        {
          header: 'Full Name',
          accessor: (row: typeof data[0]) => `${row.firstName} ${row.lastName}`,
        },
      ];

      const result = generateCsv(data, columns);

      expect(result).toBe('Full Name\nJohn Doe\nJane Smith');
    });

    it('should handle empty data', () => {
      const data: { name: string }[] = [];
      const columns = [{ header: 'Name', accessor: 'name' as const }];

      const result = generateCsv(data, columns);

      expect(result).toBe('Name');
    });
  });

  describe('downloadCsv', () => {
    it('should create blob URL and trigger download', () => {
      const createObjectURLMock = vi.fn().mockReturnValue('blob:test-url');
      const revokeObjectURLMock = vi.fn();
      globalThis.URL.createObjectURL = createObjectURLMock;
      globalThis.URL.revokeObjectURL = revokeObjectURLMock;

      downloadCsv('name,value\ntest,123', 'export.csv');

      expect(createObjectURLMock).toHaveBeenCalled();
      expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:test-url');
    });
  });

  describe('formatDateForCsv', () => {
    it('should format date to ISO string', () => {
      const result = formatDateForCsv('2024-01-15T10:30:00Z');

      expect(result).toBe('2024-01-15T10:30:00.000Z');
    });

    it('should return empty string for null', () => {
      const result = formatDateForCsv(null);

      expect(result).toBe('');
    });
  });

  describe('generateExportFilename', () => {
    it('should generate filename with date prefix', () => {
      const result = generateExportFilename('records');

      expect(result).toMatch(/^records-\d{4}-\d{2}-\d{2}\.csv$/);
    });
  });
});
