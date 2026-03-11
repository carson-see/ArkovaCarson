/**
 * CSV Export Utility
 *
 * Functions for exporting data to CSV format.
 */

interface CsvColumn<T> {
  header: string;
  accessor: keyof T | ((row: T) => string);
}

/**
 * Escapes a CSV value by wrapping in quotes if needed and escaping quotes.
 */
function escapeCsvValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';

  const stringValue = String(value);

  // Check if value needs escaping (contains comma, newline, or quote)
  if (stringValue.includes(',') || stringValue.includes('\n') || stringValue.includes('"')) {
    // Escape quotes by doubling them and wrap in quotes
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

/**
 * Generates a CSV string from an array of objects.
 */
export function generateCsv<T extends Record<string, unknown>>(
  data: T[],
  columns: CsvColumn<T>[]
): string {
  // Generate header row
  const headerRow = columns
    .map((col) => escapeCsvValue(col.header))
    .join(',');

  // Generate data rows
  const dataRows = data.map((row) => {
    return columns
      .map((col) => {
        const value = typeof col.accessor === 'function'
          ? col.accessor(row)
          : row[col.accessor];
        return escapeCsvValue(value as string | number | null);
      })
      .join(',');
  });

  return [headerRow, ...dataRows].join('\n');
}

/**
 * Triggers a download of a CSV file in the browser.
 */
export function downloadCsv(csvContent: string, filename: string): void {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';

  document.body.appendChild(link);
  link.click();
  link.remove();

  URL.revokeObjectURL(url);
}

/**
 * Formats a date for CSV export (ISO format).
 */
export function formatDateForCsv(dateString: string | null): string {
  if (!dateString) return '';
  return new Date(dateString).toISOString();
}

/**
 * Generates a filename with timestamp for exports.
 */
export function generateExportFilename(prefix: string): string {
  const timestamp = new Date().toISOString().split('T')[0];
  return `${prefix}-${timestamp}.csv`;
}
