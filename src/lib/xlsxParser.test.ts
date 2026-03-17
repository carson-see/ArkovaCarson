/**
 * Unit tests for XLSX parser (BETA-05)
 */

import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { isExcelFile, parseExcelFile, parseSpreadsheetFile } from './xlsxParser';

// Helper to create a mock File
function createMockFile(name: string, type: string, content?: ArrayBuffer): File {
  const blob = content ? new Blob([content], { type }) : new Blob([], { type });
  return new File([blob], name, { type });
}

// Helper to create a real XLSX buffer for testing
function createTestWorkbook(data: unknown[][]): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  return buffer;
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

describe('parseExcelFile', () => {
  it('parses a simple XLSX with headers and data', async () => {
    const buffer = createTestWorkbook([
      ['fingerprint', 'filename', 'email'],
      ['a'.repeat(64), 'diploma.pdf', 'student@example.com'],
      ['b'.repeat(64), 'transcript.pdf', 'grad@example.com'],
    ]);
    const file = new File([buffer], 'test.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    const result = await parseExcelFile(file);

    expect(result.columns).toHaveLength(3);
    expect(result.columns[0].name).toBe('fingerprint');
    expect(result.columns[1].name).toBe('filename');
    expect(result.columns[2].name).toBe('email');

    expect(result.rows).toHaveLength(2);
    expect(result.totalRows).toBe(2);
    expect(result.rows[0].data.fingerprint).toBe('a'.repeat(64));
    expect(result.rows[0].data.email).toBe('student@example.com');
    expect(result.rows[1].data.filename).toBe('transcript.pdf');
  });

  it('sets sample values from first data row', async () => {
    const buffer = createTestWorkbook([
      ['name', 'value'],
      ['first', '100'],
      ['second', '200'],
    ]);
    const file = new File([buffer], 'test.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    const result = await parseExcelFile(file);

    expect(result.columns[0].sample).toBe('first');
    expect(result.columns[1].sample).toBe('100');
  });

  it('handles empty workbook', async () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([]);
    XLSX.utils.book_append_sheet(workbook, sheet, 'Empty');
    const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
    const file = new File([buffer], 'empty.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    const result = await parseExcelFile(file);

    expect(result.columns).toHaveLength(0);
    expect(result.rows).toHaveLength(0);
    expect(result.totalRows).toBe(0);
  });

  it('handles header-only workbook (no data rows)', async () => {
    const buffer = createTestWorkbook([
      ['fingerprint', 'filename', 'email'],
    ]);
    const file = new File([buffer], 'header-only.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    const result = await parseExcelFile(file);

    expect(result.columns).toHaveLength(3);
    expect(result.rows).toHaveLength(0);
    expect(result.totalRows).toBe(0);
  });

  it('skips empty rows in data', async () => {
    const buffer = createTestWorkbook([
      ['name', 'value'],
      ['first', '100'],
      ['', ''],
      ['third', '300'],
    ]);
    const file = new File([buffer], 'gaps.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    const result = await parseExcelFile(file);

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].data.name).toBe('first');
    expect(result.rows[1].data.name).toBe('third');
  });

  it('converts numeric cells to strings', async () => {
    const buffer = createTestWorkbook([
      ['id', 'size'],
      [1, 1024],
      [2, 2048],
    ]);
    const file = new File([buffer], 'numbers.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    const result = await parseExcelFile(file);

    expect(result.rows[0].data.id).toBe('1');
    expect(result.rows[0].data.size).toBe('1024');
  });

  it('uses 1-indexed row numbers', async () => {
    const buffer = createTestWorkbook([
      ['col'],
      ['row1'],
      ['row2'],
    ]);
    const file = new File([buffer], 'indexed.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    const result = await parseExcelFile(file);

    expect(result.rows[0].rowNumber).toBe(2); // Header is row 1
    expect(result.rows[1].rowNumber).toBe(3);
  });
});

describe('parseSpreadsheetFile', () => {
  it('delegates to parseExcelFile for .xlsx', async () => {
    const buffer = createTestWorkbook([
      ['col'],
      ['val'],
    ]);
    const file = new File([buffer], 'test.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    const result = await parseSpreadsheetFile(file);

    expect(result.columns).toHaveLength(1);
    expect(result.rows).toHaveLength(1);
  });

  it('delegates to parseCsvFile for .csv', async () => {
    const csvContent = 'col\nval\n';
    const file = new File([csvContent], 'test.csv', { type: 'text/csv' });

    const result = await parseSpreadsheetFile(file);

    expect(result.columns).toHaveLength(1);
    expect(result.rows).toHaveLength(1);
  });
});
