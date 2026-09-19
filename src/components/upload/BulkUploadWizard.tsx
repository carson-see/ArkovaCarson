/**
 * Bulk Upload Wizard Component
 *
 * End-to-end wizard for bulk document anchoring via CSV upload.
 * Uses real CSV parsing and backend batch execution with progress tracking.
 */

import { useState, useCallback } from 'react';
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
import { BULK_IMPORT_LABELS, TOAST, RECORD_ATTESTATION_LABELS } from '@/lib/copy';
import { Checkbox } from '@/components/ui/checkbox';
import { useBulkAnchors } from '@/hooks/useBulkAnchors';
import { parsePrivateTags } from '@/hooks/usePrivateTagSuggestions';
import { useSecuringCapability } from '@/hooks/useSecuringCapability';
import type { SecuringPath } from '@/lib/queueContract';
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
  needsCredit: number;
  held: number;
  instantFailed: number;
  instantPending: number;
  instantUnknown: number;
  partial: boolean;
  action: SecuringPath;
}

function toProcessingResult(bulkResult: Awaited<ReturnType<ReturnType<typeof useBulkAnchors>['createBulkAnchors']>>, action: SecuringPath): ProcessingResult | null {
  if (!bulkResult) return null;
  const statuses = bulkResult.results ?? [];
  return {
    total: bulkResult.total, created: bulkResult.created, skipped: bulkResult.skipped, failed: bulkResult.failed,
    needsCredit: statuses.filter((row) => row.instant_status === 'NEEDS_CREDIT').length,
    held: statuses.filter((row) => row.instant_status === 'HELD').length,
    instantFailed: statuses.filter((row) => row.instant_status === 'FAILED').length,
    instantPending: statuses.filter((row) => ['QUEUED', 'PROCESSING', 'RETRYABLE'].includes(row.instant_status ?? '')).length,
    instantUnknown: action === 'instant' ? statuses.filter((row) => row.status !== 'failed' && !row.instant_status).length : 0,
    partial: bulkResult.partial === true,
    action,
  };
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
  initialFiles?: File[];
  orgId?: string | null;
}

function isSpreadsheetUploadFile(file: File): boolean {
  const lowerName = file.name.toLowerCase();
  return lowerName.endsWith('.csv')
    || lowerName.endsWith('.xlsx')
    || lowerName.endsWith('.xls')
    || file.type === 'text/csv'
    || file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    || file.type === 'application/vnd.ms-excel';
}

export function BulkUploadWizard({ onComplete, onCancel, initialFiles = [], orgId = null }: Readonly<BulkUploadWizardProps>) {
  const [step, setStep] = useState<Step>('upload');
  const [parsedCsv, setParsedCsv] = useState<ParsedCsv | null>(null);
  const [columns, setColumns] = useState<CsvColumn[]>([]);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [result, setResult] = useState<ProcessingResult | null>(null);
  // R19 (CTO ruling 2026-07-28): issuer-attestation acknowledgement, required
  // whenever no fingerprint column is mapped (record-derived rows).
  const [attested, setAttested] = useState(false);
  const [extractionResults, setExtractionResults] = useState<BatchExtractionResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<SecuringPath>('queue');
  const [description, setDescription] = useState('');
  const [userTagsInput, setUserTagsInput] = useState('');
  const [organizationTagsInput, setOrganizationTagsInput] = useState('');
  const [queuedInitialFile, setQueuedInitialFile] = useState<File | null>(
    () => initialFiles.find(isSpreadsheetUploadFile) ?? null
  );

  const {
    createBulkAnchors,
    progress,
    processedCount,
    totalCount,
    error: bulkError,
  } = useBulkAnchors({ orgId });
  const { capability } = useSecuringCapability(orgId);
  const instantAvailable = capability.canSecureInstantly && capability.creditBalance >= capability.instantSecureCost;

  const submissionOptions = useCallback(() => {
    const userTags = parsePrivateTags(userTagsInput);
    const organizationTags = parsePrivateTags(organizationTagsInput);
    if (!userTags.ok || !organizationTags.ok) throw new Error('Private tags are invalid. Use no more than 10 tags of 64 characters each.');
    return { attested, action, description, privateTags: { user: userTags.tags, organization: organizationTags.tags } };
  }, [action, attested, description, organizationTagsInput, userTagsInput]);

  // Sync hook error into component error state — derived inline instead of effect
  // to avoid cascading renders from synchronous setState in useEffect.
  const displayError = bulkError || error;

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
      const options = submissionOptions();
      // Enrich valid records with extraction results if available
      // Uses async version to auto-generate fingerprints when not in CSV
      const extractedRecords = await extractAnchorRecordsAsync(validation.valid, columns, mapping);
      const records = extractionResults
        ? mergeExtractionResults(extractedRecords, extractionResults)
        : extractedRecords;

      const bulkResult = await createBulkAnchors(records, options);

      if (bulkResult) {
        const processingResult = toProcessingResult(bulkResult, options.action);
        if (!processingResult) return;
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
  }, [parsedCsv, mapping, validation, columns, createBulkAnchors, extractionResults, onComplete, submissionOptions]);

  const handleExtractionComplete = useCallback((results: BatchExtractionResult[]) => {
    setExtractionResults(results);
    // Auto-advance to processing
    setStep('processing');
    setError(null);
    // Trigger processing via the already-defined handler
    if (parsedCsv && mapping && validation) {
      extractAnchorRecordsAsync(validation.valid, columns, mapping)
        .then((records) => createBulkAnchors(mergeExtractionResults(records, results), submissionOptions()))
        .then((bulkResult) => {
          if (bulkResult) {
            const selectedAction = submissionOptions().action;
            const processingResult = toProcessingResult(bulkResult, selectedAction);
            if (!processingResult) return;
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
  }, [parsedCsv, mapping, validation, columns, createBulkAnchors, onComplete, submissionOptions]);

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
    setQueuedInitialFile(null);
    setAttested(false);
    setAction('queue');
    setDescription('');
    setUserTagsInput('');
    setOrganizationTagsInput('');
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
    <Card className="min-w-0 w-full max-w-2xl mx-auto">
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
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-medium sm:h-8 sm:w-8',
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
                    'h-0.5 w-2 mx-1 sm:w-12 sm:mx-2',
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
        {displayError && (
          <Alert variant="destructive" className="mb-4">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{displayError}</AlertDescription>
          </Alert>
        )}

        {/* Step: Upload */}
        {step === 'upload' && (
          <CsvUploader
            onParsed={handleCsvParsed}
            initialFile={queuedInitialFile}
            onInitialFileConsumed={() => setQueuedInitialFile(null)}
          />
        )}

        {/* Step: Review */}
        {step === 'review' && validation && mapping && (
          <ReviewStep
            validation={validation}
            columns={columns}
            mapping={mapping}
            onMappingChange={handleUpdateMapping}
            onBack={handleReset}
            onProcess={handleGoToExtraction}
            attested={attested}
            onAttestedChange={setAttested}
            action={action}
            onActionChange={setAction}
            instantAvailable={instantAvailable}
            description={description}
            onDescriptionChange={setDescription}
            userTagsInput={userTagsInput}
            onUserTagsInputChange={setUserTagsInput}
            organizationTagsInput={organizationTagsInput}
            onOrganizationTagsInputChange={setOrganizationTagsInput}
            showOrganizationTags={Boolean(orgId)}
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

export function mergeExtractionResults(records: import('@/lib/csvParser').BulkAnchorRecord[], results: BatchExtractionResult[]) {
  const allowedFields = new Set([
    'credentialType', 'subType', 'issuerName', 'issuedDate', 'expiryDate',
    'fieldOfStudy', 'degreeLevel', 'licenseNumber', 'accreditingBody',
    'jurisdiction', 'creditHours', 'creditType', 'barNumber', 'activityNumber',
    'providerName', 'approvedBy', 'description',
  ]);
  const byIndex = new Map(results.filter((result) => result.success && result.fields).map((result) => [result.index, result.fields!]));
  return records.map((record, index) => {
    const fields = byIndex.get(index);
    if (!fields) return record;
    const trustedFields = Object.fromEntries(
      Object.entries(fields).filter(([key, value]) => allowedFields.has(key) && typeof value === 'string'),
    );
    return { ...record, metadata: { ...trustedFields, ...(record.metadata ?? {}) } };
  });
}

// Sub-components

function ReviewStep({
  validation,
  columns,
  mapping,
  onMappingChange,
  onBack,
  onProcess,
  attested,
  onAttestedChange,
  action,
  onActionChange,
  instantAvailable,
  description,
  onDescriptionChange,
  userTagsInput,
  onUserTagsInputChange,
  organizationTagsInput,
  onOrganizationTagsInputChange,
  showOrganizationTags,
}: Readonly<{
  validation: ValidationResult;
  columns: CsvColumn[];
  mapping: ColumnMapping;
  onMappingChange: (mapping: ColumnMapping) => void;
  onBack: () => void;
  onProcess: () => void;
  attested: boolean;
  onAttestedChange: (attested: boolean) => void;
  action: SecuringPath;
  onActionChange: (action: SecuringPath) => void;
  instantAvailable: boolean;
  description: string;
  onDescriptionChange: (value: string) => void;
  userTagsInput: string;
  onUserTagsInputChange: (value: string) => void;
  organizationTagsInput: string;
  onOrganizationTagsInputChange: (value: string) => void;
  showOrganizationTags: boolean;
}>) {
  // R19 (CTO ruling 2026-07-28): no fingerprint column mapped → every valid
  // row will be record-derived (issuer attestation), never document-derived.
  const requiresAttestation = mapping.fingerprint === null;
  const instantSelectionUnavailable = action === 'instant' && !instantAvailable;
  const canProcess = validation.valid.length > 0 && (!requiresAttestation || attested) && !instantSelectionUnavailable;
  const renderSelect = (
    label: string,
    value: number | null,
    onChange: (value: number | null) => void,
    required?: boolean
  ) => (
    <div className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-sm">
        {label}
        {required && <span className="text-destructive ml-1">*</span>}
      </span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value ? Number.parseInt(e.target.value) : null)}
        className="min-w-0 w-full rounded-md border border-input bg-background px-3 py-1 text-sm sm:w-48"
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
          'Document Type',
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

      {/* R19: issuer-attestation acknowledgement, required when no fingerprint
          column is mapped — every valid row becomes a record-derived
          (issuer-attested) anchor, never a document fingerprint. */}
      {requiresAttestation && (
        <div
          className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 space-y-2"
          data-testid="record-attestation-notice"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <span className="text-sm font-medium">{RECORD_ATTESTATION_LABELS.SECTION_TITLE}</span>
          </div>
          <p className="text-xs text-muted-foreground">{RECORD_ATTESTATION_LABELS.BODY}</p>
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <Checkbox
              checked={attested}
              onCheckedChange={(checked) => onAttestedChange(checked === true)}
              data-testid="record-attestation-checkbox"
            />
            <span>{RECORD_ATTESTATION_LABELS.CHECKBOX_LABEL}</span>
          </label>
        </div>
      )}

      <div className="space-y-3 rounded-lg border p-4">
        <label className="block space-y-1 text-sm font-medium">
          {BULK_IMPORT_LABELS.DESCRIPTION}
          <textarea value={description} maxLength={1000} onChange={(event) => onDescriptionChange(event.target.value)} className="mt-1 w-full rounded-md border bg-background px-3 py-2" />
        </label>
        <label className="block space-y-1 text-sm font-medium">
          {BULK_IMPORT_LABELS.USER_TAGS}
          <input value={userTagsInput} onChange={(event) => onUserTagsInputChange(event.target.value)} className="mt-1 w-full rounded-md border bg-background px-3 py-2" placeholder="Add tags separated by commas" />
        </label>
        {showOrganizationTags && <label className="block space-y-1 text-sm font-medium">
          {BULK_IMPORT_LABELS.ORGANIZATION_TAGS}
          <input value={organizationTagsInput} onChange={(event) => onOrganizationTagsInputChange(event.target.value)} className="mt-1 w-full rounded-md border bg-background px-3 py-2" placeholder="Add tags separated by commas" />
        </label>}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant={action === 'queue' ? 'default' : 'outline'} onClick={() => onActionChange('queue')}>{BULK_IMPORT_LABELS.QUEUE_ACTION}</Button>
          <Button type="button" disabled={!instantAvailable && action !== 'instant'} variant={action === 'instant' ? 'default' : 'outline'} onClick={() => onActionChange('instant')}>{BULK_IMPORT_LABELS.INSTANT_ACTION}</Button>
        </div>
        {instantSelectionUnavailable && (
          <p className="text-xs text-amber-700" role="alert">
            {BULK_IMPORT_LABELS.INSTANT_UNAVAILABLE}
          </p>
        )}
        {action === 'instant' && instantAvailable && (
          <p className="text-xs text-muted-foreground">
            {BULK_IMPORT_LABELS.INSTANT_CREDIT_COST(validation.valid.length)}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2 pt-4 sm:flex-row sm:justify-between">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button onClick={onProcess} disabled={!canProcess}>
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
  const hasInstantIssues = result.needsCredit + result.held + result.instantFailed + result.instantUnknown > 0;
  const hasFailures = result.failed > 0 || result.partial || hasInstantIssues;

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
          {hasFailures ? BULK_IMPORT_LABELS.COMPLETE_WITH_ISSUES : BULK_IMPORT_LABELS.COMPLETE}
        </h3>
        <p className="text-sm text-muted-foreground">
          {result.partial ? BULK_IMPORT_LABELS.PARTIAL_BODY : BULK_IMPORT_LABELS.SAVED_BODY}
        </p>
      </div>

      <div className="flex justify-center gap-4 pt-2 flex-wrap">
        <Badge variant="default" className="text-base px-4 py-1 bg-green-600">
          {BULK_IMPORT_LABELS.CREATED(result.created)}
        </Badge>
        {result.skipped > 0 && (
          <Badge variant="secondary" className="text-base px-4 py-1">
            {BULK_IMPORT_LABELS.SKIPPED(result.skipped)}
          </Badge>
        )}
        {result.failed > 0 && (
          <Badge variant="destructive" className="text-base px-4 py-1">
            {BULK_IMPORT_LABELS.FAILED(result.failed)}
          </Badge>
        )}
        {result.needsCredit > 0 && (
          <Badge variant="outline" className="text-base px-4 py-1">
            {BULK_IMPORT_LABELS.NEEDS_CREDIT(result.needsCredit)}
          </Badge>
        )}
        {result.held > 0 && <Badge variant="outline" className="text-base px-4 py-1">{BULK_IMPORT_LABELS.HELD(result.held)}</Badge>}
        {result.instantFailed > 0 && <Badge variant="destructive" className="text-base px-4 py-1">{BULK_IMPORT_LABELS.INSTANT_FAILED(result.instantFailed)}</Badge>}
        {result.instantPending > 0 && <Badge variant="secondary" className="text-base px-4 py-1">{BULK_IMPORT_LABELS.INSTANT_PENDING(result.instantPending)}</Badge>}
        {result.instantUnknown > 0 && <Badge variant="outline" className="text-base px-4 py-1">{BULK_IMPORT_LABELS.INSTANT_UNKNOWN(result.instantUnknown)}</Badge>}
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
