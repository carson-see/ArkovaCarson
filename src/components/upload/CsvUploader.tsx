/**
 * CSV Uploader Component
 *
 * Handles CSV file upload, parsing, and validation with email pre-flight checks.
 */

import { useState, useCallback } from 'react';
import { Upload, FileSpreadsheet, AlertCircle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  parseCsvFile,
  autoDetectMapping,
  validateCsvRows,
  type ParsedCsv,
  type ColumnMapping,
  type ValidationResult,
} from '@/lib/csvParser';

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
}: CsvUploaderProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const processFile = useCallback(
    async (file: File) => {
      setLoading(true);
      setError(null);

      try {
        // Validate file type
        if (!file.name.endsWith('.csv') && file.type !== 'text/csv') {
          throw new Error('Please upload a CSV file.');
        }

        // Validate file size (max 10MB)
        if (file.size > 10 * 1024 * 1024) {
          throw new Error('File size must be less than 10MB.');
        }

        // Parse CSV
        const parsed = await parseCsvFile(file);

        if (parsed.rows.length === 0) {
          throw new Error('CSV file is empty or has no data rows.');
        }

        if (parsed.rows.length > maxRows) {
          throw new Error(`CSV file has too many rows (max ${maxRows.toLocaleString()}).`);
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
        const message = err instanceof Error ? err.message : 'Failed to parse CSV file.';
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
            <p className="text-sm font-medium mb-1">Processing CSV...</p>
            <p className="text-xs text-muted-foreground">
              Parsing and validating rows
            </p>
          </>
        ) : (
          <>
            <FileSpreadsheet className="h-10 w-10 text-muted-foreground mb-4" />
            <p className="text-sm font-medium mb-1">
              {dragActive ? 'Drop your CSV file here' : 'Drop your CSV file here'}
            </p>
            <p className="text-xs text-muted-foreground mb-4">or click to browse</p>
            <Button type="button" variant="secondary" size="sm" disabled={loading}>
              <Upload className="mr-2 h-4 w-4" />
              Select CSV File
            </Button>
          </>
        )}
        <input
          id="csv-file-upload"
          type="file"
          accept=".csv,text/csv"
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
