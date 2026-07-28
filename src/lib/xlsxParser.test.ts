/**
 * Unit tests for XLSX parser (BETA-05)
 *
 * Since read-excel-file is read-only, tests use mock File objects.
 * isExcelFile tests use filename/mime detection (no actual parsing).
 * parseExcelFile tests are integration-level using real xlsx buffers
 * created via a minimal xlsx generator helper.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  // ---------------------------------------------------------------------
  // W2 / F1 regression pin — row/records mode (the ORIGINAL bulk-issuance
  // intent, founder ruling 2026-07-28) must stay byte-for-byte UNCHANGED by
  // the new document-mode extraction path added in ocrWorker.ts. This file
  // (read-excel-file-backed) was not touched by that change; this test
  // proves a real .xlsx fixture still parses into per-row records correctly.
  // ---------------------------------------------------------------------
  it('parses a genuine .xlsx fixture into one row per record — row mode is UNCHANGED', async () => {
    const bytes = readFileSync(
      join(import.meta.dirname, 'fixtures', 'spreadsheets', 'sample-roster.xlsx'),
    );
    const file = new File([bytes], 'sample-roster.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    const result = await parseSpreadsheetFile(file);

    expect(result.columns.map((c) => c.name)).toEqual(['Name', 'Role', 'Notes']);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0].data).toEqual({
      Name: 'Alice Rivera',
      Role: 'Engineer',
      Notes: 'Backend team',
    });
    expect(result.rows[2].data.Name).toBe('Cara Osei');
  });
});
