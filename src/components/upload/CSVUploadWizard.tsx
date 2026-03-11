/**
 * CSV Upload Wizard Component
 *
 * Multi-step wizard for bulk document anchoring via CSV upload.
 * Uses real CSV parsing, validation, and bulk anchor creation.
 *
 * @see CRIT-6 — replaced mock/simulated data with real parsers
 */

import { useState, useCallback, useRef } from 'react';
import {
  Upload,
  FileSpreadsheet,
  ArrowRight,
  ArrowLeft,
  CheckCircle,
  AlertCircle,
  Loader2,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  parseCsvFile,
  autoDetectMapping,
  validateCsvRows,
  extractAnchorRecords,
} from '@/lib/csvParser';
import type { CsvColumn, CsvRow, ColumnMapping, ValidationResult } from '@/lib/csvParser';
import { useBulkAnchors } from '@/hooks/useBulkAnchors';

type Step = 'upload' | 'mapping' | 'validation' | 'processing' | 'complete';

interface ProcessingResult {
  total: number;
  successful: number;
  failed: number;
}

const STEPS: { key: Step; label: string }[] = [
  { key: 'upload', label: 'Upload' },
  { key: 'mapping', label: 'Map Columns' },
  { key: 'validation', label: 'Validate' },
  { key: 'processing', label: 'Process' },
  { key: 'complete', label: 'Complete' },
];

interface CSVUploadWizardProps {
  onComplete?: (result: ProcessingResult) => void;
  onCancel?: () => void;
}

export function CSVUploadWizard({ onComplete, onCancel }: Readonly<CSVUploadWizardProps>) {
  const [step, setStep] = useState<Step>('upload');
  const [columns, setColumns] = useState<CsvColumn[]>([]);
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>({
    fingerprint: null,
    filename: null,
    fileSize: null,
    email: null,
    credentialType: null,
    metadata: null,
  });
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [result, setResult] = useState<ProcessingResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const validRowsRef = useRef<CsvRow[]>([]);
  const { createBulkAnchors, loading: bulkLoading, progress, processedCount, totalCount } = useBulkAnchors();

  const currentStepIndex = STEPS.findIndex(s => s.key === step);

  const handleFileUpload = useCallback(async (uploadedFile: File) => {
    setError(null);
    try {
      const parsed = await parseCsvFile(uploadedFile);

      if (parsed.columns.length === 0) {
        setError('CSV file is empty or has no headers.');
        return;
      }

      if (parsed.rows.length === 0) {
        setError('CSV file has headers but no data rows.');
        return;
      }

      setColumns(parsed.columns);
      setRows(parsed.rows);

      const detectedMapping = autoDetectMapping(parsed.columns);
      setMapping(detectedMapping);

      setStep('mapping');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse CSV file.');
    }
  }, []);

  const handleValidate = useCallback(async () => {
    setStep('validation');
    setError(null);

    const result = validateCsvRows(rows, columns, mapping);
    validRowsRef.current = result.valid;
    setValidation(result);
  }, [rows, columns, mapping]);

  const handleProcess = useCallback(async () => {
    if (!validation || validRowsRef.current.length === 0) return;

    setStep('processing');
    setError(null);

    const records = extractAnchorRecords(validRowsRef.current, columns, mapping);
    const bulkResult = await createBulkAnchors(records);

    if (bulkResult) {
      const processingResult: ProcessingResult = {
        total: bulkResult.total,
        successful: bulkResult.created + bulkResult.skipped,
        failed: bulkResult.failed,
      };
      setResult(processingResult);
      setStep('complete');
      onComplete?.(processingResult);
    } else {
      // Error is handled by useBulkAnchors hook
      setError('Processing failed. Please try again.');
      setStep('validation');
    }
  }, [validation, columns, mapping, createBulkAnchors, onComplete]);

  const handleReset = useCallback(() => {
    setStep('upload');
    setColumns([]);
    setRows([]);
    setMapping({
      fingerprint: null,
      filename: null,
      fileSize: null,
      email: null,
      credentialType: null,
      metadata: null,
    });
    setValidation(null);
    validRowsRef.current = [];
    setResult(null);
    setError(null);
  }, []);

  return (
    <Card className="max-w-2xl mx-auto">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5" />
              Bulk Upload Records
            </CardTitle>
            <CardDescription>
              Upload a CSV file to secure multiple documents at once.
            </CardDescription>
          </div>
          {onCancel && step !== 'processing' && (
            <Button variant="ghost" size="icon" onClick={onCancel}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </CardHeader>

      {/* Progress steps */}
      <div className="px-6 pb-4">
        <div className="flex items-center justify-between">
          {STEPS.map((s, index) => (
            <div key={s.key} className="flex items-center">
              <div
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium',
                  index <= currentStepIndex
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground'
                )}
              >
                {index < currentStepIndex ? (
                  <CheckCircle className="h-4 w-4" />
                ) : (
                  index + 1
                )}
              </div>
              {index < STEPS.length - 1 && (
                <div
                  className={cn(
                    'h-0.5 w-8 mx-2',
                    index < currentStepIndex ? 'bg-primary' : 'bg-muted'
                  )}
                />
              )}
            </div>
          ))}
        </div>
        <div className="flex justify-between mt-2">
          {STEPS.map(s => (
            <span
              key={s.key}
              className={cn(
                'text-xs',
                s.key === step ? 'text-foreground font-medium' : 'text-muted-foreground'
              )}
            >
              {s.label}
            </span>
          ))}
        </div>
      </div>

      <Separator />

      <CardContent className="pt-6">
        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Step: Upload */}
        {step === 'upload' && (
          <UploadStep onFileUpload={handleFileUpload} />
        )}

        {/* Step: Column Mapping */}
        {step === 'mapping' && (
          <MappingStep
            columns={columns}
            mapping={mapping}
            onMappingChange={setMapping}
            onBack={() => setStep('upload')}
            onNext={handleValidate}
          />
        )}

        {/* Step: Validation */}
        {step === 'validation' && (
          <ValidationStep
            validation={validation}
            onBack={() => setStep('mapping')}
            onProcess={handleProcess}
          />
        )}

        {/* Step: Processing */}
        {step === 'processing' && (
          <ProcessingStep
            progress={progress}
            current={processedCount}
            total={totalCount}
            loading={bulkLoading}
          />
        )}

        {/* Step: Complete */}
        {step === 'complete' && result && (
          <CompleteStep result={result} onReset={handleReset} />
        )}
      </CardContent>
    </Card>
  );
}

// Sub-components for each step

function UploadStep({ onFileUpload }: Readonly<{ onFileUpload: (file: File) => void }>) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onFileUpload(file);
    }
  };

  return (
    <div className="space-y-4">
      <label
        htmlFor="csv-upload"
        className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 cursor-pointer hover:border-muted-foreground/50 transition-colors"
      >
        <Upload className="h-10 w-10 text-muted-foreground mb-4" />
        <p className="text-sm font-medium mb-1">Drop your CSV file here</p>
        <p className="text-xs text-muted-foreground mb-4">or click to browse</p>
        <Button type="button" variant="secondary" size="sm">
          Select CSV File
        </Button>
        <input
          id="csv-upload"
          type="file"
          accept=".csv"
          className="sr-only"
          onChange={handleChange}
        />
      </label>
      <div className="text-xs text-muted-foreground space-y-1">
        <p>Required columns: fingerprint, filename</p>
        <p>Optional columns: file_size, email, credential_type, metadata</p>
      </div>
    </div>
  );
}

function MappingStep({
  columns,
  mapping,
  onMappingChange,
  onBack,
  onNext,
}: Readonly<{
  columns: CsvColumn[];
  mapping: ColumnMapping;
  onMappingChange: (mapping: ColumnMapping) => void;
  onBack: () => void;
  onNext: () => void;
}>) {
  const isValid = mapping.fingerprint !== null && mapping.filename !== null;

  const renderSelect = (
    label: string,
    value: number | null,
    onChange: (value: number | null) => void,
    required?: boolean
  ) => (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm">
        {label}
        {required && <span className="text-destructive ml-1">*</span>}
      </span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value ? Number.parseInt(e.target.value) : null)}
        className="w-48 rounded-md border border-input bg-background px-3 py-1 text-sm"
      >
        <option value="">Select column</option>
        {columns.map((col) => (
          <option key={col.index} value={col.index}>
            {col.name} {col.sample ? `(${col.sample.slice(0, 20)})` : ''}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        {renderSelect(
          'Fingerprint',
          mapping.fingerprint,
          (v) => onMappingChange({ ...mapping, fingerprint: v }),
          true
        )}
        <Separator />
        {renderSelect(
          'Filename',
          mapping.filename,
          (v) => onMappingChange({ ...mapping, filename: v }),
          true
        )}
        <Separator />
        {renderSelect(
          'File Size',
          mapping.fileSize,
          (v) => onMappingChange({ ...mapping, fileSize: v })
        )}
        <Separator />
        {renderSelect(
          'Email',
          mapping.email,
          (v) => onMappingChange({ ...mapping, email: v })
        )}
        <Separator />
        {renderSelect(
          'Credential Type',
          mapping.credentialType,
          (v) => onMappingChange({ ...mapping, credentialType: v })
        )}
        <Separator />
        {renderSelect(
          'Metadata',
          mapping.metadata,
          (v) => onMappingChange({ ...mapping, metadata: v })
        )}
      </div>

      <div className="flex justify-between pt-4">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button onClick={onNext} disabled={!isValid}>
          Validate
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function ValidationStep({
  validation,
  onBack,
  onProcess,
}: Readonly<{
  validation: ValidationResult | null;
  onBack: () => void;
  onProcess: () => void;
}>) {
  if (!validation) {
    return (
      <div className="flex flex-col items-center py-8">
        <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
        <p className="text-sm text-muted-foreground">Validating records...</p>
      </div>
    );
  }

  const validCount = validation.valid.length;
  const invalidCount = validation.invalid.length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <Card className="border-success/50 bg-success/5">
          <CardContent className="pt-4">
            <div className="text-2xl font-bold text-success">{validCount}</div>
            <p className="text-sm text-muted-foreground">Valid records</p>
          </CardContent>
        </Card>
        <Card className={cn(invalidCount > 0 && 'border-destructive/50 bg-destructive/5')}>
          <CardContent className="pt-4">
            <div className={cn('text-2xl font-bold', invalidCount > 0 ? 'text-destructive' : '')}>
              {invalidCount}
            </div>
            <p className="text-sm text-muted-foreground">Invalid records</p>
          </CardContent>
        </Card>
      </div>

      {validation.errors.length > 0 && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Row</TableHead>
                <TableHead>Column</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {validation.errors.slice(0, 5).map((err) => (
                <TableRow key={`${err.row}-${err.column}`}>
                  <TableCell className="font-mono">{err.row}</TableCell>
                  <TableCell className="text-muted-foreground">{err.column}</TableCell>
                  <TableCell className="text-destructive">{err.message}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {validation.errors.length > 5 && (
            <div className="px-4 py-2 text-xs text-muted-foreground border-t">
              And {validation.errors.length - 5} more errors...
            </div>
          )}
        </div>
      )}

      <div className="flex justify-between pt-4">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button onClick={onProcess} disabled={validCount === 0}>
          Process {validCount} Records
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function ProcessingStep({
  progress,
  current,
  total,
  loading,
}: Readonly<{
  progress: number;
  current: number;
  total: number;
  loading: boolean;
}>) {
  return (
    <div className="space-y-4 py-4">
      <div className="flex justify-center">
        {loading ? (
          <Loader2 className="h-10 w-10 animate-spin text-primary" />
        ) : (
          <CheckCircle className="h-10 w-10 text-primary" />
        )}
      </div>
      <div className="text-center space-y-2">
        <p className="font-medium">{loading ? 'Processing records...' : 'Finalizing...'}</p>
        <p className="text-sm text-muted-foreground">
          {current} of {total} records
        </p>
      </div>
      <Progress value={progress} className="w-full" />
      <p className="text-xs text-center text-muted-foreground">
        Please do not close this window
      </p>
    </div>
  );
}

function CompleteStep({
  result,
  onReset,
}: Readonly<{
  result: ProcessingResult;
  onReset: () => void;
}>) {
  return (
    <div className="space-y-4 py-4 text-center">
      <div className="flex justify-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-success/10">
          <CheckCircle className="h-8 w-8 text-success" />
        </div>
      </div>
      <div>
        <h3 className="text-lg font-semibold">Upload Complete</h3>
        <p className="text-sm text-muted-foreground">
          Your records have been processed.
        </p>
      </div>

      <div className="flex justify-center gap-4 pt-2">
        <Badge variant="success" className="text-base px-4 py-1">
          {result.successful} Secured
        </Badge>
        {result.failed > 0 && (
          <Badge variant="destructive" className="text-base px-4 py-1">
            {result.failed} Failed
          </Badge>
        )}
      </div>

      <Button onClick={onReset} className="mt-4">
        Upload Another File
      </Button>
    </div>
  );
}
