/**
 * CSV Parser Utility
 *
 * Parses CSV files and validates data for bulk operations.
 */

import { z } from 'zod';

// Valid credential type values (matches credential_type enum in DB)
export const VALID_CREDENTIAL_TYPES = [
  'DEGREE',
  'LICENSE',
  'CERTIFICATE',
  'TRANSCRIPT',
  'PROFESSIONAL',
  'OTHER',
] as const;

export type CredentialType = (typeof VALID_CREDENTIAL_TYPES)[number];

// Email validation regex (non-backtracking to avoid ReDoS)
const EMAIL_REGEX = /^[^\s@]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

// Fingerprint validation (SHA-256 hex string)
const FINGERPRINT_REGEX = /^[a-fA-F0-9]{64}$/;

export interface CsvColumn {
  index: number;
  name: string;
  sample: string;
}

export interface CsvRow {
  rowNumber: number;
  data: Record<string, string>;
}

export interface ParsedCsv {
  columns: CsvColumn[];
  rows: CsvRow[];
  totalRows: number;
}

export interface ValidationError {
  row: number;
  column: string;
  message: string;
}

export interface ValidationResult {
  valid: CsvRow[];
  invalid: CsvRow[];
  errors: ValidationError[];
}

export interface ColumnMapping {
  fingerprint: number | null;
  filename: number | null;
  fileSize: number | null;
  email: number | null;
  credentialType: number | null;
  metadata: number | null;
}

/**
 * Parses a CSV string into structured data.
 * Handles quoted fields and escaped quotes.
 */
export function parseCsvString(csvContent: string): ParsedCsv {
  const lines = csvContent.split(/\r?\n/).filter(line => line.trim() !== '');

  if (lines.length === 0) {
    return { columns: [], rows: [], totalRows: 0 };
  }

  // Parse header row
  const headerLine = lines[0];
  const headers = parseCsvLine(headerLine);

  const columns: CsvColumn[] = headers.map((name, index) => ({
    index,
    name: name.trim(),
    sample: '',
  }));

  // Parse data rows
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const data: Record<string, string> = {};

    headers.forEach((header, index) => {
      data[header.trim()] = values[index]?.trim() || '';
    });

    rows.push({
      rowNumber: i + 1, // 1-indexed for user display
      data,
    });

    // Set sample values from first row
    if (i === 1) {
      columns.forEach((col, index) => {
        col.sample = values[index]?.trim() || '';
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
 * Parses a single CSV line, handling quoted fields.
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        current += '"';
        i++;
      } else {
        // Toggle quote mode
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current);
  return result;
}

/**
 * Parses a CSV file and returns structured data.
 */
export async function parseCsvFile(file: File): Promise<ParsedCsv> {
  const content = await file.text();
  return parseCsvString(content);
}

/**
 * Validates email format.
 */
export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email.trim());
}

/**
 * Validates fingerprint format (SHA-256 hex).
 */
export function isValidFingerprint(fingerprint: string): boolean {
  return FINGERPRINT_REGEX.test(fingerprint.trim());
}

/**
 * Auto-detects column mapping from column names.
 */
export function autoDetectMapping(columns: CsvColumn[]): ColumnMapping {
  const mapping: ColumnMapping = {
    fingerprint: null,
    filename: null,
    fileSize: null,
    email: null,
    credentialType: null,
    metadata: null,
  };

  for (const col of columns) {
    const name = col.name.toLowerCase().trim();

    if (name.includes('fingerprint') || name.includes('hash') || name === 'sha256') {
      mapping.fingerprint = col.index;
    } else if (name === 'filename' || name === 'file_name' || name === 'file name' || name === 'file') {
      // Exact match only — avoids false positives like "First Name", "Last Name"
      mapping.filename = col.index;
    } else if (name.includes('size') || name === 'bytes') {
      mapping.fileSize = col.index;
    } else if (name.includes('email') || name.includes('e-mail') || name.includes('mail')) {
      mapping.email = col.index;
    } else if (
      name === 'credential_type' || name === 'credential type' ||
      name === 'credentialtype' || name === 'type' || name === 'credential'
    ) {
      mapping.credentialType = col.index;
    } else if (name === 'metadata' || name === 'meta' || name === 'extra') {
      mapping.metadata = col.index;
    }
  }

  return mapping;
}

// ── Per-field validators (extracted to reduce cognitive complexity) ──────────

type ColumnNameGetter = (index: number | null) => string;
type FieldValueGetter = (row: CsvRow, index: number | null) => string;

/** Shared helper: look up a field value by column index. */
function makeFieldValueGetter(columns: CsvColumn[]): FieldValueGetter {
  return (row, index) => {
    if (index === null) return '';
    const colName = columns[index]?.name;
    return colName ? row.data[colName] || '' : '';
  };
}

function validateFingerprintField(
  row: CsvRow, mapping: ColumnMapping,
  getColumnName: ColumnNameGetter, getValueByIndex: FieldValueGetter
): ValidationError[] {
  // Fingerprint is optional — auto-generated from row data when absent
  if (mapping.fingerprint === null) return [];
  const fingerprint = getValueByIndex(row, mapping.fingerprint);
  // Allow empty fingerprint (will be auto-generated)
  if (!fingerprint) return [];
  if (!isValidFingerprint(fingerprint)) {
    return [{ row: row.rowNumber, column: getColumnName(mapping.fingerprint), message: 'Invalid fingerprint format (expected 64-character hex)' }];
  }
  return [];
}

function validateFilenameField(
  _row: CsvRow, mapping: ColumnMapping,
  _getColumnName: ColumnNameGetter, _getValueByIndex: FieldValueGetter
): ValidationError[] {
  // Filename is optional — auto-generated from row data when absent
  if (mapping.filename === null) return [];
  // Allow empty filename (will be auto-generated)
  return [];
}

function validateEmailField(
  row: CsvRow, mapping: ColumnMapping,
  getColumnName: ColumnNameGetter, getValueByIndex: FieldValueGetter
): ValidationError[] {
  if (mapping.email === null) return [];
  const email = getValueByIndex(row, mapping.email);
  if (email && !isValidEmail(email)) {
    return [{ row: row.rowNumber, column: getColumnName(mapping.email), message: 'Invalid email format' }];
  }
  return [];
}

function validateFileSizeField(
  row: CsvRow, mapping: ColumnMapping,
  getColumnName: ColumnNameGetter, getValueByIndex: FieldValueGetter
): ValidationError[] {
  if (mapping.fileSize === null) return [];
  const sizeStr = getValueByIndex(row, mapping.fileSize);
  if (sizeStr) {
    const size = Number.parseInt(sizeStr, 10);
    if (Number.isNaN(size) || size < 0) {
      return [{ row: row.rowNumber, column: getColumnName(mapping.fileSize), message: 'File size must be a positive number' }];
    }
  }
  return [];
}

function validateCredentialTypeField(
  row: CsvRow, mapping: ColumnMapping,
  getColumnName: ColumnNameGetter, getValueByIndex: FieldValueGetter
): ValidationError[] {
  if (mapping.credentialType === null) return [];
  const credType = getValueByIndex(row, mapping.credentialType);
  if (credType && !VALID_CREDENTIAL_TYPES.includes(credType.toUpperCase() as CredentialType)) {
    return [{ row: row.rowNumber, column: getColumnName(mapping.credentialType), message: `Invalid credential type. Must be one of: ${VALID_CREDENTIAL_TYPES.join(', ')}` }];
  }
  return [];
}

function validateMetadataField(
  row: CsvRow, mapping: ColumnMapping,
  getColumnName: ColumnNameGetter, getValueByIndex: FieldValueGetter
): ValidationError[] {
  if (mapping.metadata === null) return [];
  const metaStr = getValueByIndex(row, mapping.metadata);
  if (!metaStr) return [];
  try {
    const parsed = JSON.parse(metaStr);
    if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
      return [{ row: row.rowNumber, column: getColumnName(mapping.metadata), message: 'Metadata must be a JSON object' }];
    }
  } catch {
    return [{ row: row.rowNumber, column: getColumnName(mapping.metadata), message: 'Metadata must be valid JSON' }];
  }
  return [];
}

// ── Main validation function ────────────────────────────────────────────────

/**
 * Validates parsed CSV rows against the column mapping.
 * Pre-flight validation identifies invalid emails.
 */
export function validateCsvRows(
  rows: CsvRow[],
  columns: CsvColumn[],
  mapping: ColumnMapping
): ValidationResult {
  const valid: CsvRow[] = [];
  const invalid: CsvRow[] = [];
  const errors: ValidationError[] = [];

  const getColumnName: ColumnNameGetter = (index) => {
    if (index === null) return 'unknown';
    return columns[index]?.name || `column_${index}`;
  };

  const getValueByIndex = makeFieldValueGetter(columns);

  for (const row of rows) {
    const rowErrors = [
      ...validateFingerprintField(row, mapping, getColumnName, getValueByIndex),
      ...validateFilenameField(row, mapping, getColumnName, getValueByIndex),
      ...validateEmailField(row, mapping, getColumnName, getValueByIndex),
      ...validateFileSizeField(row, mapping, getColumnName, getValueByIndex),
      ...validateCredentialTypeField(row, mapping, getColumnName, getValueByIndex),
      ...validateMetadataField(row, mapping, getColumnName, getValueByIndex),
    ];

    if (rowErrors.length > 0) {
      invalid.push(row);
      errors.push(...rowErrors);
    } else {
      valid.push(row);
    }
  }

  return { valid, invalid, errors };
}

/**
 * Schema for bulk anchor record from CSV.
 */
export const bulkAnchorSchema = z.object({
  fingerprint: z.string().min(1, 'Fingerprint is required'),
  filename: z.string().min(1, 'Filename is required'),
  fileSize: z.number().int().positive().optional(),
  email: z.string().email().optional(),
  credentialType: z.enum(VALID_CREDENTIAL_TYPES).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type BulkAnchorRecord = z.infer<typeof bulkAnchorSchema>;

/**
 * Generates a SHA-256 fingerprint from a string (runs in browser).
 * Used to auto-generate fingerprints when CSV rows don't include one.
 */
async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Builds a deterministic string from all row data for fingerprinting.
 * Sorts keys to ensure consistency regardless of column order.
 */
function buildRowCanonical(row: CsvRow): string {
  return Object.keys(row.data)
    .sort()
    .map(k => `${k}=${row.data[k]}`)
    .join('|');
}

/**
 * Auto-generates a filename from row data (first non-empty text column value).
 */
function autoFilename(row: CsvRow, rowIndex: number): string {
  // Try common name columns first
  const nameKeys = ['name', 'recipient', 'student', 'holder', 'title', 'document', 'subject'];
  for (const key of nameKeys) {
    for (const col of Object.keys(row.data)) {
      if (col.toLowerCase().includes(key) && row.data[col]?.trim()) {
        return `${row.data[col].trim()}.credential`;
      }
    }
  }
  // Fall back to first non-empty value
  for (const val of Object.values(row.data)) {
    if (val?.trim()) return `${val.trim().slice(0, 60)}.credential`;
  }
  return `row_${rowIndex}.credential`;
}

/**
 * Extracts anchor records from validated CSV rows.
 * Auto-generates fingerprints and filenames when not provided in the CSV.
 */
export function extractAnchorRecords(
  rows: CsvRow[],
  columns: CsvColumn[],
  mapping: ColumnMapping
): BulkAnchorRecord[] {
  const getValueByIndex = makeFieldValueGetter(columns);

  // We return a sync array of records but fingerprints may need async generation.
  // For the sync path (fingerprint column exists), use it directly.
  // For async path, we pre-compute in extractAnchorRecordsAsync below.
  return rows.map((row, i) => {
    const hasFingerprint = mapping.fingerprint !== null;
    const hasFilename = mapping.filename !== null;

    const record: BulkAnchorRecord = {
      fingerprint: hasFingerprint
        ? getValueByIndex(row, mapping.fingerprint).toLowerCase()
        : '', // Placeholder — filled by extractAnchorRecordsAsync
      filename: hasFilename
        ? getValueByIndex(row, mapping.filename)
        : autoFilename(row, i + 1),
    };

    if (mapping.fileSize !== null) {
      const sizeStr = getValueByIndex(row, mapping.fileSize);
      if (sizeStr) {
        record.fileSize = Number.parseInt(sizeStr, 10);
      }
    }

    if (mapping.email !== null) {
      const email = getValueByIndex(row, mapping.email);
      if (email) {
        record.email = email.toLowerCase();
      }
    }

    if (mapping.credentialType !== null) {
      const credType = getValueByIndex(row, mapping.credentialType);
      if (credType) {
        record.credentialType = credType.toUpperCase() as CredentialType;
      }
    }

    // Build metadata from ALL columns (not just a dedicated metadata column)
    const allMetadata: Record<string, unknown> = {};
    for (const col of columns) {
      // Skip columns that are already mapped to specific fields
      const isMapped = [mapping.fingerprint, mapping.filename, mapping.fileSize, mapping.email, mapping.credentialType, mapping.metadata].includes(col.index);
      if (!isMapped && row.data[col.name]?.trim()) {
        allMetadata[col.name] = row.data[col.name].trim();
      }
    }

    if (mapping.metadata !== null) {
      const metaStr = getValueByIndex(row, mapping.metadata);
      if (metaStr) {
        try {
          Object.assign(allMetadata, JSON.parse(metaStr));
        } catch {
          // Skip invalid JSON
        }
      }
    }

    if (Object.keys(allMetadata).length > 0) {
      record.metadata = allMetadata;
    }

    return record;
  });
}

/**
 * Async version that auto-generates SHA-256 fingerprints from row data
 * when no fingerprint column is present in the CSV.
 */
export async function extractAnchorRecordsAsync(
  rows: CsvRow[],
  columns: CsvColumn[],
  mapping: ColumnMapping
): Promise<BulkAnchorRecord[]> {
  const records = extractAnchorRecords(rows, columns, mapping);

  // If no fingerprint column, generate fingerprints from row data
  if (mapping.fingerprint === null) {
    await Promise.all(
      records.map(async (record, i) => {
        const canonical = buildRowCanonical(rows[i]);
        record.fingerprint = await sha256Hex(canonical);
      })
    );
  }

  return records;
}
