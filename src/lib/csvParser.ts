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
    const name = col.name.toLowerCase();

    if (name.includes('fingerprint') || name.includes('hash') || name === 'sha256') {
      mapping.fingerprint = col.index;
    } else if (name.includes('filename') || name.includes('name') || name === 'file') {
      mapping.filename = col.index;
    } else if (name.includes('size') || name === 'bytes') {
      mapping.fileSize = col.index;
    } else if (name.includes('email') || name.includes('mail')) {
      mapping.email = col.index;
    } else if (
      name.includes('credential_type') ||
      name.includes('credentialtype') ||
      name === 'type' ||
      name === 'credential'
    ) {
      mapping.credentialType = col.index;
    } else if (name.includes('metadata') || name === 'meta' || name === 'extra') {
      mapping.metadata = col.index;
    }
  }

  return mapping;
}

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

  const getColumnName = (index: number | null): string => {
    if (index === null) return 'unknown';
    return columns[index]?.name || `column_${index}`;
  };

  const getValueByIndex = (row: CsvRow, index: number | null): string => {
    if (index === null) return '';
    const colName = columns[index]?.name;
    return colName ? row.data[colName] || '' : '';
  };

  for (const row of rows) {
    const rowErrors: ValidationError[] = [];

    // Validate fingerprint (required)
    if (mapping.fingerprint !== null) {
      const fingerprint = getValueByIndex(row, mapping.fingerprint);
      if (!fingerprint) {
        rowErrors.push({
          row: row.rowNumber,
          column: getColumnName(mapping.fingerprint),
          message: 'Fingerprint is required',
        });
      } else if (!isValidFingerprint(fingerprint)) {
        rowErrors.push({
          row: row.rowNumber,
          column: getColumnName(mapping.fingerprint),
          message: 'Invalid fingerprint format (expected 64-character hex)',
        });
      }
    }

    // Validate filename (required)
    if (mapping.filename !== null) {
      const filename = getValueByIndex(row, mapping.filename);
      if (!filename) {
        rowErrors.push({
          row: row.rowNumber,
          column: getColumnName(mapping.filename),
          message: 'Filename is required',
        });
      }
    }

    // Validate email (if mapped)
    if (mapping.email !== null) {
      const email = getValueByIndex(row, mapping.email);
      if (email && !isValidEmail(email)) {
        rowErrors.push({
          row: row.rowNumber,
          column: getColumnName(mapping.email),
          message: 'Invalid email format',
        });
      }
    }

    // Validate file size (if mapped, must be numeric)
    if (mapping.fileSize !== null) {
      const sizeStr = getValueByIndex(row, mapping.fileSize);
      if (sizeStr) {
        const size = parseInt(sizeStr, 10);
        if (isNaN(size) || size < 0) {
          rowErrors.push({
            row: row.rowNumber,
            column: getColumnName(mapping.fileSize),
            message: 'File size must be a positive number',
          });
        }
      }
    }

    // Validate credential type (if mapped, must be valid enum value)
    if (mapping.credentialType !== null) {
      const credType = getValueByIndex(row, mapping.credentialType);
      if (credType && !VALID_CREDENTIAL_TYPES.includes(credType.toUpperCase() as CredentialType)) {
        rowErrors.push({
          row: row.rowNumber,
          column: getColumnName(mapping.credentialType),
          message: `Invalid credential type. Must be one of: ${VALID_CREDENTIAL_TYPES.join(', ')}`,
        });
      }
    }

    // Validate metadata (if mapped, must be valid JSON object)
    if (mapping.metadata !== null) {
      const metaStr = getValueByIndex(row, mapping.metadata);
      if (metaStr) {
        try {
          const parsed = JSON.parse(metaStr);
          if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
            rowErrors.push({
              row: row.rowNumber,
              column: getColumnName(mapping.metadata),
              message: 'Metadata must be a JSON object',
            });
          }
        } catch {
          rowErrors.push({
            row: row.rowNumber,
            column: getColumnName(mapping.metadata),
            message: 'Metadata must be valid JSON',
          });
        }
      }
    }

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
  fingerprint: z.string().regex(FINGERPRINT_REGEX, 'Invalid fingerprint format'),
  filename: z.string().min(1, 'Filename is required'),
  fileSize: z.number().int().positive().optional(),
  email: z.string().email().optional(),
  credentialType: z.enum(VALID_CREDENTIAL_TYPES).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type BulkAnchorRecord = z.infer<typeof bulkAnchorSchema>;

/**
 * Extracts anchor records from validated CSV rows.
 */
export function extractAnchorRecords(
  rows: CsvRow[],
  columns: CsvColumn[],
  mapping: ColumnMapping
): BulkAnchorRecord[] {
  const getValueByIndex = (row: CsvRow, index: number | null): string => {
    if (index === null) return '';
    const colName = columns[index]?.name;
    return colName ? row.data[colName] || '' : '';
  };

  return rows.map(row => {
    const record: BulkAnchorRecord = {
      fingerprint: getValueByIndex(row, mapping.fingerprint).toLowerCase(),
      filename: getValueByIndex(row, mapping.filename),
    };

    if (mapping.fileSize !== null) {
      const sizeStr = getValueByIndex(row, mapping.fileSize);
      if (sizeStr) {
        record.fileSize = parseInt(sizeStr, 10);
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

    if (mapping.metadata !== null) {
      const metaStr = getValueByIndex(row, mapping.metadata);
      if (metaStr) {
        try {
          record.metadata = JSON.parse(metaStr);
        } catch {
          // Skip invalid JSON — already caught in validation
        }
      }
    }

    return record;
  });
}
