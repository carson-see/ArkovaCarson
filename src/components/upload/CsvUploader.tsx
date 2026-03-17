/**
 * Spreadsheet Uploader Component
 *
 * Handles CSV and Excel (.xlsx/.xls) file upload, parsing, and validation
 * with email pre-flight checks.
 *
 * BETA-05: Added Excel support via SheetJS.
 */

import { useState, useCallback } from 'react';
import { Upload, FileSpreadsheet, AlertCircle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  autoDetectMapping,
  validateCsvRows,
  type ParsedCsv,
  type ColumnMapping,
  type ValidationResult,
} from '@/lib/csvParser';
import { parseSpreadsheetFile, isExcelFile } from '@/lib/xlsxParser';

interface CsvUploaderProps {
  onParsed: (
    csv: ParsedCsv,
    mapping: ColumnMapping,
    validation: ValidationResult
  ) => void;
  maxRows?: number;
  className?: string;
}

export function CsvUploader({
  onParsed,
  maxRows = 10000,
  className,
}: Readonly<CsvUploaderProps>) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const processFile = useCallback(
    async (file: File) => {
      setLoading(true);
      setError(null);

      try {
        // Validate file type (CSV or Excel)
        const isCsv = file.name.endsWith('.csv') || file.type === 'text/csv';
        const isExcel = isExcelFile(file);
        if (!isCsv && !isExcel) {
          throw new Error('Please upload a CSV or Excel (.xlsx, .xls) file.');
        }

        // Validate file size (max 10MB)
        if (file.size > 10 * 1024 * 1024) {
          throw new Error('File size must be less than 10MB.');
        }

        // Parse spreadsheet (CSV or Excel)
        const parsed = await parseSpreadsheetFile(file);

        if (parsed.rows.length === 0) {
          throw new Error('File is empty or has no data rows.');
        }

        if (parsed.rows.length > maxRows) {
          throw new Error(`File has too many rows (max ${maxRows.toLocaleString()}).`);
        }

        // Auto-detect column mapping
        const mapping = autoDetectMapping(parsed.columns);

        // Validate required columns are mapped
        if (mapping.fingerprint === null) {
          throw new Error(
            'Could not detect fingerprint column. Please ensure your CSV has a column named "fingerprint" or "sha256".'
          );
        }

        if (mapping.filename === null) {
          throw new Error(
            'Could not detect filename column. Please ensure your CSV has a column named "filename", "name", or "file".'
          );
        }

        // Validate all rows
        const validation = validateCsvRows(parsed.rows, parsed.columns, mapping);

        // Pass results to parent
        onParsed(parsed, mapping, validation);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to parse file.';
        setError(message);
      } finally {
        setLoading(false);
      }
    },
    [maxRows, onParsed]
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        processFile(file);
      }
      // Reset input so same file can be re-selected
      e.target.value = '';
    },
    [processFile]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLLabelElement>) => {
      e.preventDefault();
      setDragActive(false);

      const file = e.dataTransfer.files?.[0];
      if (file) {
        processFile(file);
      }
    },
    [processFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragActive(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragActive(false);
  }, []);

  return (
    <div className={cn('space-y-4', className)}>
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <label
        htmlFor="csv-file-upload"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={cn(
          'flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 cursor-pointer transition-colors',
          dragActive
            ? 'border-primary bg-primary/5'
            : 'hover:border-muted-foreground/50',
          loading && 'pointer-events-none opacity-50'
        )}
      >
        {loading ? (
          <>
            <Loader2 className="h-10 w-10 text-primary mb-4 animate-spin" />
            <p className="text-sm font-medium mb-1">Processing file...</p>
            <p className="text-xs text-muted-foreground">
              Parsing and validating rows
            </p>
          </>
        ) : (
          <>
            <FileSpreadsheet className="h-10 w-10 text-muted-foreground mb-4" />
            <p className="text-sm font-medium mb-1">
              Drop your CSV or Excel file here
            </p>
            <p className="text-xs text-muted-foreground mb-4">or click to browse</p>
            <Button type="button" variant="secondary" size="sm" disabled={loading}>
              <Upload className="mr-2 h-4 w-4" />
              Select File
            </Button>
          </>
        )}
        <input
          id="csv-file-upload"
          type="file"
          accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
          className="sr-only"
          onChange={handleFileChange}
          disabled={loading}
        />
      </label>

      <div className="text-xs text-muted-foreground space-y-1">
        <p>
          <strong>Required columns:</strong> fingerprint (or sha256), filename
        </p>
        <p>
          <strong>Optional columns:</strong> file_size, email, credential_type, metadata
        </p>
        <p className="text-muted-foreground/70">
          Maximum {maxRows.toLocaleString()} rows. File must be under 10MB.
        </p>
      </div>
    </div>
  );
}
