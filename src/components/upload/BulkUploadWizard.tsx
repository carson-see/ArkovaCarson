/**
 * Bulk Upload Wizard Component
 *
 * End-to-end wizard for bulk document anchoring via CSV upload.
 * Uses real CSV parsing and backend batch execution with progress tracking.
 */

import { useState, useCallback, useEffect } from 'react';
import {
  FileSpreadsheet,
  ArrowRight,
  ArrowLeft,
  CheckCircle,
  AlertCircle,
  Loader2,
  X,
  AlertTriangle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
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
import { CsvUploader } from './CsvUploader';
import { AIExtractionStep, type BatchExtractionResult } from './AIExtractionStep';
import { toast } from 'sonner';
import { TOAST } from '@/lib/copy';
import { useBulkAnchors } from '@/hooks/useBulkAnchors';
import {
  type ParsedCsv,
  type ColumnMapping,
  type ValidationResult,
  type CsvColumn,
  extractAnchorRecordsAsync,
  validateCsvRows,
} from '@/lib/csvParser';

type Step = 'upload' | 'review' | 'extraction' | 'processing' | 'complete';

interface ProcessingResult {
  total: number;
  created: number;
  skipped: number;
  failed: number;
}

const STEPS: { key: Step; label: string }[] = [
  { key: 'upload', label: 'Upload' },
  { key: 'review', label: 'Review' },
  { key: 'extraction', label: 'AI Extract' },
  { key: 'processing', label: 'Process' },
  { key: 'complete', label: 'Complete' },
];

interface BulkUploadWizardProps {
  onComplete?: (result: ProcessingResult) => void;
  onCancel?: () => void;
}

export function BulkUploadWizard({ onComplete, onCancel }: Readonly<BulkUploadWizardProps>) {
  const [step, setStep] = useState<Step>('upload');
  const [parsedCsv, setParsedCsv] = useState<ParsedCsv | null>(null);
  const [columns, setColumns] = useState<CsvColumn[]>([]);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [result, setResult] = useState<ProcessingResult | null>(null);
  const [_extractionResults, setExtractionResults] = useState<BatchExtractionResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const {
    createBulkAnchors,
    progress,
    processedCount,
    totalCount,
    error: bulkError,
  } = useBulkAnchors();

  // Sync hook error into component error state so it renders in the UI
  useEffect(() => {
    if (bulkError) setError(bulkError);
  }, [bulkError]);

  const currentStepIndex = STEPS.findIndex((s) => s.key === step);

  const handleCsvParsed = useCallback(
    (csv: ParsedCsv, detectedMapping: ColumnMapping, validationResult: ValidationResult) => {
      setParsedCsv(csv);
      setColumns(csv.columns);
      setMapping(detectedMapping);
      setValidation(validationResult);
      setError(null);
      setStep('review');
    },
    []
  );

  const handleGoToExtraction = useCallback(() => {
    setStep('extraction');
    setError(null);
  }, []);

  const handleProcess = useCallback(async () => {
    if (!parsedCsv || !mapping || !validation) return;

    setStep('processing');
    setError(null);

    try {
      // Enrich valid records with extraction results if available
      // Uses async version to auto-generate fingerprints when not in CSV
      const records = await extractAnchorRecordsAsync(validation.valid, columns, mapping);

      const bulkResult = await createBulkAnchors(records);

      if (bulkResult) {
        const processingResult: ProcessingResult = {
          total: bulkResult.total,
          created: bulkResult.created,
          skipped: bulkResult.skipped,
          failed: bulkResult.failed,
        };
        setResult(processingResult);
        setStep('complete');
        onComplete?.(processingResult);
      } else {
        // Note: bulkError from useBulkAnchors is set asynchronously,
        // so read it via the hook state rather than the closure value
        toast.error(TOAST.BULK_FAILED);
        setStep('review');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to process records';
      toast.error(message);
      setError(message);
      setStep('review');
    }
  }, [parsedCsv, mapping, validation, columns, createBulkAnchors, onComplete]);

  const handleExtractionComplete = useCallback((results: BatchExtractionResult[]) => {
    setExtractionResults(results);
    // Auto-advance to processing
    setStep('processing');
    setError(null);
    // Trigger processing via the already-defined handler
    if (parsedCsv && mapping && validation) {
      extractAnchorRecordsAsync(validation.valid, columns, mapping)
        .then((records) => createBulkAnchors(records))
        .then((bulkResult) => {
          if (bulkResult) {
            const processingResult: ProcessingResult = {
              total: bulkResult.total,
              created: bulkResult.created,
              skipped: bulkResult.skipped,
              failed: bulkResult.failed,
            };
            setResult(processingResult);
            setStep('complete');
            onComplete?.(processingResult);
          } else {
            toast.error(TOAST.BULK_FAILED);
            setStep('review');
          }
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : 'Failed to process records';
          toast.error(message);
          setError(message);
          setStep('review');
        });
    }
  }, [parsedCsv, mapping, validation, columns, createBulkAnchors, onComplete]);

  const handleSkipExtraction = useCallback(() => {
    setExtractionResults(null);
    handleProcess();
  }, [handleProcess]);

  const handleReset = useCallback(() => {
    setStep('upload');
    setParsedCsv(null);
    setColumns([]);
    setMapping(null);
    setValidation(null);
    setResult(null);
    setExtractionResults(null);
    setError(null);
  }, []);

  const handleUpdateMapping = useCallback(
    (newMapping: ColumnMapping) => {
      setMapping(newMapping);
      if (parsedCsv) {
        const newValidation = validateCsvRows(parsedCsv.rows, columns, newMapping);
        setValidation(newValidation);
      }
    },
    [parsedCsv, columns]
  );

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
                    'h-0.5 w-12 mx-2',
                    index < currentStepIndex ? 'bg-primary' : 'bg-muted'
                  )}
                />
              )}
            </div>
          ))}
        </div>
        <div className="flex justify-between mt-2">
          {STEPS.map((s) => (
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
        {step === 'upload' && <CsvUploader onParsed={handleCsvParsed} />}

        {/* Step: Review */}
        {step === 'review' && validation && mapping && (
          <ReviewStep
            validation={validation}
            columns={columns}
            mapping={mapping}
            onMappingChange={handleUpdateMapping}
            onBack={handleReset}
            onProcess={handleGoToExtraction}
          />
        )}

        {/* Step: AI Extraction */}
        {step === 'extraction' && parsedCsv && validation && mapping && (
          <AIExtractionStep
            rows={validation.valid}
            columns={columns}
            mapping={mapping}
            onComplete={handleExtractionComplete}
            onBack={() => setStep('review')}
            onSkip={handleSkipExtraction}
          />
        )}

        {/* Step: Processing */}
        {step === 'processing' && (
          <ProcessingStep
            progress={progress}
            current={processedCount}
            total={totalCount}
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

// Sub-components

function ReviewStep({
  validation,
  columns,
  mapping,
  onMappingChange,
  onBack,
  onProcess,
}: Readonly<{
  validation: ValidationResult;
  columns: CsvColumn[];
  mapping: ColumnMapping;
  onMappingChange: (mapping: ColumnMapping) => void;
  onBack: () => void;
  onProcess: () => void;
}>) {
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
            {col.name}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Column mapping */}
      <div className="space-y-1">
        <h4 className="text-sm font-medium mb-2">Column Mapping</h4>
        <p className="text-xs text-muted-foreground mb-3">
          Map your spreadsheet columns below. Fingerprint and filename are auto-generated if not mapped. Unmapped columns become metadata automatically.
        </p>
        {renderSelect(
          'Fingerprint',
          mapping.fingerprint,
          (v) => onMappingChange({ ...mapping, fingerprint: v })
        )}
        <Separator />
        {renderSelect(
          'Filename',
          mapping.filename,
          (v) => onMappingChange({ ...mapping, filename: v })
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
          'Metadata (JSON)',
          mapping.metadata,
          (v) => onMappingChange({ ...mapping, metadata: v })
        )}
      </div>

      {/* Validation summary */}
      <div className="grid grid-cols-2 gap-4 mt-4">
        <Card className="border-green-500/50 bg-green-500/5">
          <CardContent className="pt-4">
            <div className="text-2xl font-bold text-green-600">
              {validation.valid.length}
            </div>
            <p className="text-sm text-muted-foreground">Valid records</p>
          </CardContent>
        </Card>
        <Card
          className={cn(
            validation.invalid.length > 0 &&
              'border-destructive/50 bg-destructive/5'
          )}
        >
          <CardContent className="pt-4">
            <div
              className={cn(
                'text-2xl font-bold',
                validation.invalid.length > 0 ? 'text-destructive' : ''
              )}
            >
              {validation.invalid.length}
            </div>
            <p className="text-sm text-muted-foreground">Invalid records</p>
          </CardContent>
        </Card>
      </div>

      {/* Errors list */}
      {validation.errors.length > 0 && (
        <div className="rounded-lg border">
          <div className="px-4 py-2 border-b bg-muted/50 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <span className="text-sm font-medium">Validation Errors</span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-20">Row</TableHead>
                <TableHead>Column</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {validation.errors.slice(0, 5).map((err, idx) => (
                <TableRow key={`${err.row}-${err.column}-${idx}`}>
                  <TableCell className="font-mono">{err.row}</TableCell>
                  <TableCell>{err.column}</TableCell>
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
        <Button onClick={onProcess} disabled={validation.valid.length === 0}>
          Process {validation.valid.length} Records
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
}: Readonly<{
  progress: number;
  current: number;
  total: number;
}>) {
  return (
    <div className="space-y-4 py-4">
      <div className="flex justify-center">
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
      </div>
      <div className="text-center space-y-2">
        <p className="font-medium">Processing records...</p>
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
  const hasFailures = result.failed > 0;

  return (
    <div className="space-y-4 py-4 text-center">
      <div className="flex justify-center">
        <div
          className={cn(
            'flex h-16 w-16 items-center justify-center rounded-full',
            hasFailures ? 'bg-amber-500/10' : 'bg-green-500/10'
          )}
        >
          {hasFailures ? (
            <AlertTriangle className="h-8 w-8 text-amber-500" />
          ) : (
            <CheckCircle className="h-8 w-8 text-green-500" />
          )}
        </div>
      </div>
      <div>
        <h3 className="text-lg font-semibold">
          {hasFailures ? 'Upload Completed with Issues' : 'Upload Complete'}
        </h3>
        <p className="text-sm text-muted-foreground">
          Your records have been processed.
        </p>
      </div>

      <div className="flex justify-center gap-4 pt-2 flex-wrap">
        <Badge variant="default" className="text-base px-4 py-1 bg-green-600">
          {result.created} Created
        </Badge>
        {result.skipped > 0 && (
          <Badge variant="secondary" className="text-base px-4 py-1">
            {result.skipped} Skipped
          </Badge>
        )}
        {result.failed > 0 && (
          <Badge variant="destructive" className="text-base px-4 py-1">
            {result.failed} Failed
          </Badge>
        )}
      </div>

      {result.skipped > 0 && (
        <p className="text-xs text-muted-foreground">
          Skipped records already exist in your vault.
        </p>
      )}

      <Button onClick={onReset} className="mt-4">
        Upload Another File
      </Button>
    </div>
  );
}
