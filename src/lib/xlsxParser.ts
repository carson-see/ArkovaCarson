/**
 * XLSX Parser Utility (BETA-05)
 *
 * Parses Excel (.xlsx/.xls) files using SheetJS and converts them
 * to the same ParsedCsv structure used by the CSV parser.
 * This allows the BulkUploadWizard to accept Excel files seamlessly.
 *
 * Constitution refs:
 *   - 1.6: Document processing is client-side only (SheetJS runs in browser)
 */

import * as XLSX from 'xlsx';
import type { ParsedCsv, CsvColumn, CsvRow } from './csvParser';

/** Safely coerce a cell value to string (avoids [object Object] for non-primitives). */
function cellToString(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'object') return JSON.stringify(cell);
  return String(cell);
}

/**
 * Check if a file is an Excel format.
 */
export function isExcelFile(file: File): boolean {
  const excelMimeTypes = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
    'application/vnd.ms-excel', // .xls
  ];

  if (excelMimeTypes.includes(file.type)) return true;

  const ext = file.name.toLowerCase();
  return ext.endsWith('.xlsx') || ext.endsWith('.xls');
}

/**
 * Parse an Excel file into the same ParsedCsv structure used by csvParser.
 *
 * Reads the first sheet of the workbook. The first row is treated as headers.
 * All cell values are converted to strings.
 *
 * @param file - Excel file (File object from browser input)
 * @returns ParsedCsv structure compatible with the existing bulk upload pipeline
 */
export async function parseExcelFile(file: File): Promise<ParsedCsv> {
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });

  // Use the first sheet
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return { columns: [], rows: [], totalRows: 0 };
  }

  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    return { columns: [], rows: [], totalRows: 0 };
  }

  // Convert sheet to array of arrays (header: 1 means first row is just data)
  const rawData: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: false, // Convert all values to strings
  });

  if (rawData.length === 0) {
    return { columns: [], rows: [], totalRows: 0 };
  }

  // First row = headers
  const headers = rawData[0].map((cell) => cellToString(cell).trim());

  const columns: CsvColumn[] = headers.map((name, index) => ({
    index,
    name,
    sample: '',
  }));

  // Remaining rows = data
  const rows: CsvRow[] = [];
  for (let i = 1; i < rawData.length; i++) {
    const rawRow = rawData[i];

    // Skip completely empty rows
    const hasData = rawRow.some((cell) => cellToString(cell).trim() !== '');
    if (!hasData) continue;

    const data: Record<string, string> = {};
    headers.forEach((header, index) => {
      data[header] = cellToString(rawRow[index]).trim();
    });

    rows.push({
      rowNumber: i + 1, // 1-indexed for user display
      data,
    });

    // Set sample values from first data row
    if (rows.length === 1) {
      columns.forEach((col, index) => {
        col.sample = cellToString(rawRow[index]).trim();
      });
    }
  }

  return {
    columns,
    rows,
    totalRows: rows.length,
  };
}

/**
 * Parse a file that could be either CSV or Excel.
 * Delegates to the appropriate parser based on file type.
 */
export async function parseSpreadsheetFile(file: File): Promise<ParsedCsv> {
  if (isExcelFile(file)) {
    return parseExcelFile(file);
  }

  // Fall back to CSV parsing
  const { parseCsvFile } = await import('./csvParser');
  return parseCsvFile(file);
}
