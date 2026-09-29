/**
 * XLSX Parser Utility (BETA-05)
 *
 * Parses Excel (.xlsx) files using read-excel-file and converts them
 * to the same ParsedCsv structure used by the CSV parser.
 * This allows the BulkUploadWizard to accept Excel files seamlessly.
 *
 * Constitution refs:
 *   - 1.6: Document processing is client-side only (runs in browser)
 */

// read-excel-file v9 ships types for the `/browser` subpath — the
// previous `@ts-ignore` suppression is no longer needed.
import { readSheet } from 'read-excel-file/browser';
import type { ParsedCsv, CsvColumn, CsvRow } from './csvParser';
import { SPREADSHEET_IMPORT_ERRORS } from './copy';

const MAX_SPREADSHEET_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_SPREADSHEET_ROWS = 10_000;
const LEGACY_XLS_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

/** Safely coerce a cell value to string (avoids [object Object] for non-primitives). */
function cellToString(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) return cell.toISOString().split('T')[0];
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
  const rawData = await readSheet(file);

  return rowsToParsedCsv(rawData);
}

function rowsToParsedCsv(rawData: readonly (readonly unknown[])[]): ParsedCsv {

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
      // defineProperty prevents special headers such as "__proto__" from
      // mutating the result object's prototype while retaining an ordinary
      // JSON-serializable record for downstream mapping.
      Object.defineProperty(data, header, {
        value: cellToString(rawRow[index]).trim(),
        enumerable: true,
        configurable: true,
        writable: true,
      });
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

async function parseLegacyXlsFile(file: File, maxRows: number): Promise<ParsedCsv> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!LEGACY_XLS_MAGIC.every((byte, index) => bytes[index] === byte)) {
    throw new Error(SPREADSHEET_IMPORT_ERRORS.INVALID_LEGACY_FILE);
  }
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(bytes, {
    type: 'array',
    cellDates: true,
    dense: true,
    cellFormula: false,
    cellHTML: false,
    // Header + allowed rows + one sentinel row lets us reject overflow
    // without parsing an attacker-controlled worksheet range in full.
    sheetRows: maxRows + 2,
  });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return rowsToParsedCsv([]);
  const sheet = workbook.Sheets[firstSheetName];
  const declaredRange = sheet['!fullref'] ?? sheet['!ref'];
  if (declaredRange && XLSX.utils.decode_range(declaredRange).e.r + 1 > maxRows + 1) {
    throw new Error(SPREADSHEET_IMPORT_ERRORS.TOO_MANY_ROWS(maxRows));
  }
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
  });
  if (rows.length > maxRows + 1) {
    throw new Error(SPREADSHEET_IMPORT_ERRORS.TOO_MANY_ROWS(maxRows));
  }
  return rowsToParsedCsv(rows);
}

/**
 * Parse a file that could be either CSV or Excel.
 * Delegates to the appropriate parser based on file type.
 */
export async function parseSpreadsheetFile(
  file: File,
  maxRows = DEFAULT_MAX_SPREADSHEET_ROWS,
): Promise<ParsedCsv> {
  if (file.size > MAX_SPREADSHEET_BYTES) {
    throw new Error(SPREADSHEET_IMPORT_ERRORS.FILE_TOO_LARGE);
  }
  if (file.name.toLowerCase().endsWith('.xls')) {
    return parseLegacyXlsFile(file, maxRows);
  }
  if (isExcelFile(file)) {
    return parseExcelFile(file);
  }

  // Fall back to CSV parsing
  const { parseCsvFile } = await import('./csvParser');
  return parseCsvFile(file);
}
