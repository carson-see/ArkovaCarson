/**
 * Shared CSV export utility.
 * Used by FERPA disclosure export (REG-01) and HIPAA audit export (REG-07).
 */

import type { Response } from 'express';

/**
 * Build CSV content from headers and rows, send as download response.
 */
export function sendCsvResponse(
  res: Response,
  filename: string,
  headers: string[],
  rows: string[][],
): void {
  const csvContent = [
    headers.join(','),
    ...rows.map((row) =>
      row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','),
    ),
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csvContent);
}
