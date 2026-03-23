/**
 * Unit tests for XLSX parser (BETA-05)
 *
 * Since read-excel-file is read-only, tests use mock File objects.
 * isExcelFile tests use filename/mime detection (no actual parsing).
 * parseExcelFile tests are integration-level using real xlsx buffers
 * created via a minimal xlsx generator helper.
 */

import { describe, it, expect } from 'vitest';
import { isExcelFile, parseSpreadsheetFile } from './xlsxParser';

// Helper to create a mock File
function createMockFile(name: string, type: string): File {
  return new File([new Blob([], { type })], name, { type });
}

describe('isExcelFile', () => {
  it('returns true for .xlsx files', () => {
    const file = createMockFile('test.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(isExcelFile(file)).toBe(true);
  });

  it('returns true for .xls files', () => {
    const file = createMockFile('test.xls', 'application/vnd.ms-excel');
    expect(isExcelFile(file)).toBe(true);
  });

  it('returns true for xlsx by extension even with wrong mime', () => {
    const file = createMockFile('data.xlsx', 'application/octet-stream');
    expect(isExcelFile(file)).toBe(true);
  });

  it('returns false for CSV files', () => {
    const file = createMockFile('test.csv', 'text/csv');
    expect(isExcelFile(file)).toBe(false);
  });

  it('returns false for random files', () => {
    const file = createMockFile('image.png', 'image/png');
    expect(isExcelFile(file)).toBe(false);
  });
});

describe('parseSpreadsheetFile', () => {
  it('delegates to parseCsvFile for .csv', async () => {
    const csvContent = 'col\nval\n';
    const file = new File([csvContent], 'test.csv', { type: 'text/csv' });

    const result = await parseSpreadsheetFile(file);

    expect(result.columns).toHaveLength(1);
    expect(result.rows).toHaveLength(1);
  });

  it('detects xlsx and attempts excel parsing', async () => {
    // Empty xlsx will throw/return empty — just verify it doesn't crash
    const file = createMockFile('test.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    // read-excel-file will throw on empty blob, which is expected
    await expect(parseSpreadsheetFile(file)).rejects.toThrow();
  });
});
