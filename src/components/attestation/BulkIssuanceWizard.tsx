/**
 * Bulk Issuance Wizard
 *
 * Multi-step wizard for bulk-issuing credential attestations via CSV upload.
 * Supports Employment Verification and Education Verification templates.
 *
 * Steps: Upload -> Column Mapping -> Preview & Validate -> Processing -> Results
 */

import { useState, useCallback, useRef } from 'react';
import {
  FileSpreadsheet,
  ArrowRight,
  ArrowLeft,
  CheckCircle,
  AlertCircle,
  Loader2,
  Upload,
  Download,
  AlertTriangle,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { supabase } from '@/lib/supabase';
import { WORKER_URL } from '@/lib/workerClient';
import { parseCsvFile, type ParsedCsv, type CsvColumn } from '@/lib/csvParser';

// ─── Types ──────────────────────────────────────────────────

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgName: string;
}

type WizardStep = 'upload' | 'mapping' | 'preview' | 'processing' | 'results';

interface AttestationColumnMapping {
  subject_identifier: string | null;
  attestation_type: string | null;
  attester_name: string | null;
  attester_type: string | null;
  summary: string | null;
  expires_at: string | null;
  jurisdiction: string | null;
  // Employment-specific
  title: string | null;
  department: string | null;
  start_date: string | null;
  end_date: string | null;
  employment_status: string | null;
  // Education-specific
  degree_type: string | null;
  field_of_study: string | null;
  institution: string | null;
  graduation_date: string | null;
  gpa: string | null;
  honors: string | null;
}

interface MappedRow {
  rowNumber: number;
  data: Record<string, string>;
  attestation: {
    subject_identifier: string;
    attestation_type: string;
    attester_name: string;
    attester_type: string;
    claims: Array<{ claim: string; evidence?: string }>;
    summary?: string;
    expires_at?: string;
    jurisdiction?: string;
    metadata?: Record<string, unknown>;
  } | null;
  error: string | null;
}

interface BatchResultItem {
  index: number;
  public_id?: string;
  status?: string;
  fingerprint?: string;
  error?: string;
}

interface BatchSummary {
  total: number;
  created: number;
  failed: number;
}

// ─── Template CSV generation ────────────────────────────────

const EMPLOYMENT_HEADERS = [
  'employee_name',
  'title',
  'department',
  'start_date',
  'end_date',
  'employment_status',
  'salary_band',
  'consent_scope',
];

const EDUCATION_HEADERS = [
  'student_name',
  'degree_type',
  'field_of_study',
  'institution',
  'graduation_date',
  'gpa',
  'honors',
];

function downloadTemplate(headers: string[], filename: string) {
  const csvContent = headers.join(',') + '\n';
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// ─── Auto-detect mapping from headers ──────────────────────

function autoDetectAttestationMapping(columns: CsvColumn[]): AttestationColumnMapping {
  const mapping: AttestationColumnMapping = {
    subject_identifier: null,
    attestation_type: null,
    attester_name: null,
    attester_type: null,
    summary: null,
    expires_at: null,
    jurisdiction: null,
    title: null,
    department: null,
    start_date: null,
    end_date: null,
    employment_status: null,
    degree_type: null,
    field_of_study: null,
    institution: null,
    graduation_date: null,
    gpa: null,
    honors: null,
  };

  for (const col of columns) {
    const name = col.name.toLowerCase().trim().replace(/[\s_-]+/g, '_');

    if (name.includes('employee_name') || name.includes('student_name') || name === 'name' || name === 'subject') {
      mapping.subject_identifier = col.name;
    } else if (name === 'attestation_type' || name === 'type') {
      mapping.attestation_type = col.name;
    } else if (name === 'attester_name' || name === 'attester' || name === 'issuer') {
      mapping.attester_name = col.name;
    } else if (name === 'attester_type') {
      mapping.attester_type = col.name;
    } else if (name === 'summary' || name === 'description' || name === 'notes') {
      mapping.summary = col.name;
    } else if (name === 'expires_at' || name === 'expiration' || name === 'expiry') {
      mapping.expires_at = col.name;
    } else if (name === 'jurisdiction' || name === 'location' || name === 'region') {
      mapping.jurisdiction = col.name;
    } else if (name === 'title' || name === 'job_title' || name === 'position') {
      mapping.title = col.name;
    } else if (name === 'department' || name === 'dept') {
      mapping.department = col.name;
    } else if (name === 'start_date' || name === 'hire_date') {
      mapping.start_date = col.name;
    } else if (name === 'end_date' || name === 'termination_date') {
      mapping.end_date = col.name;
    } else if (name === 'employment_status' || name === 'status') {
      mapping.employment_status = col.name;
    } else if (name === 'degree_type' || name === 'degree') {
      mapping.degree_type = col.name;
    } else if (name === 'field_of_study' || name === 'major' || name === 'program') {
      mapping.field_of_study = col.name;
    } else if (name === 'institution' || name === 'school' || name === 'university') {
      mapping.institution = col.name;
    } else if (name === 'graduation_date' || name === 'grad_date') {
      mapping.graduation_date = col.name;
    } else if (name === 'gpa') {
      mapping.gpa = col.name;
    } else if (name === 'honors' || name === 'distinction') {
      mapping.honors = col.name;
    }
  }

  return mapping;
}

// ─── Build attestation object from row ─────────────────────

function buildAttestationFromRow(
  row: Record<string, string>,
  mapping: AttestationColumnMapping,
  orgName: string,
): MappedRow['attestation'] {
  const subjectId = mapping.subject_identifier ? row[mapping.subject_identifier]?.trim() : '';
  if (!subjectId) return null;

  const attesterName = mapping.attester_name ? row[mapping.attester_name]?.trim() : orgName;
  const attesterType = mapping.attester_type ? row[mapping.attester_type]?.trim() : 'INSTITUTION';
  const attestationType = mapping.attestation_type ? row[mapping.attestation_type]?.trim().toUpperCase() : 'VERIFICATION';

  // Detect template type based on columns present
  const isEmployment = mapping.title || mapping.department || mapping.start_date || mapping.employment_status;
  const isEducation = mapping.degree_type || mapping.field_of_study || mapping.institution || mapping.graduation_date;

  const claims: Array<{ claim: string; evidence?: string }> = [];
  const metadata: Record<string, unknown> = {};

  if (isEmployment) {
    const title = mapping.title ? row[mapping.title]?.trim() : '';
    const dept = mapping.department ? row[mapping.department]?.trim() : '';
    const start = mapping.start_date ? row[mapping.start_date]?.trim() : '';
    const end = mapping.end_date ? row[mapping.end_date]?.trim() : '';
    const status = mapping.employment_status ? row[mapping.employment_status]?.trim() : '';

    if (title) claims.push({ claim: `Held position: ${title}` });
    if (dept) claims.push({ claim: `Department: ${dept}` });
    if (start) claims.push({ claim: `Employment start date: ${start}` });
    if (end) claims.push({ claim: `Employment end date: ${end}` });
    if (status) claims.push({ claim: `Employment status: ${status}` });
    if (!claims.length) claims.push({ claim: `Employment verified for ${subjectId}` });

    if (title) metadata.title = title;
    if (dept) metadata.department = dept;
    if (start) metadata.start_date = start;
    if (end) metadata.end_date = end;
    if (status) metadata.employment_status = status;
  } else if (isEducation) {
    const degree = mapping.degree_type ? row[mapping.degree_type]?.trim() : '';
    const field = mapping.field_of_study ? row[mapping.field_of_study]?.trim() : '';
    const inst = mapping.institution ? row[mapping.institution]?.trim() : '';
    const gradDate = mapping.graduation_date ? row[mapping.graduation_date]?.trim() : '';
    const gpa = mapping.gpa ? row[mapping.gpa]?.trim() : '';
    const honors = mapping.honors ? row[mapping.honors]?.trim() : '';

    if (degree) claims.push({ claim: `Degree awarded: ${degree}` });
    if (field) claims.push({ claim: `Field of study: ${field}` });
    if (inst) claims.push({ claim: `Institution: ${inst}` });
    if (gradDate) claims.push({ claim: `Graduation date: ${gradDate}` });
    if (gpa) claims.push({ claim: `GPA: ${gpa}` });
    if (honors) claims.push({ claim: `Honors: ${honors}` });
    if (!claims.length) claims.push({ claim: `Education verified for ${subjectId}` });

    if (degree) metadata.degree_type = degree;
    if (field) metadata.field_of_study = field;
    if (inst) metadata.institution = inst;
    if (gradDate) metadata.graduation_date = gradDate;
    if (gpa) metadata.gpa = gpa;
    if (honors) metadata.honors = honors;
  } else {
    // Generic — use summary or generate a basic claim
    const summary = mapping.summary ? row[mapping.summary]?.trim() : '';
    claims.push({ claim: summary || `Verified credential for ${subjectId}` });
  }

  const result: MappedRow['attestation'] = {
    subject_identifier: subjectId,
    attestation_type: ['VERIFICATION', 'ENDORSEMENT', 'AUDIT', 'APPROVAL', 'WITNESS', 'COMPLIANCE', 'SUPPLY_CHAIN', 'IDENTITY', 'CUSTOM'].includes(attestationType) ? attestationType : 'VERIFICATION',
    attester_name: attesterName || orgName,
    attester_type: ['INSTITUTION', 'CORPORATION', 'INDIVIDUAL', 'REGULATORY', 'THIRD_PARTY'].includes(attesterType) ? attesterType : 'INSTITUTION',
    claims,
  };

  if (mapping.summary && row[mapping.summary]?.trim()) {
    result.summary = row[mapping.summary].trim();
  }
  if (mapping.expires_at && row[mapping.expires_at]?.trim()) {
    result.expires_at = new Date(row[mapping.expires_at].trim()).toISOString();
  }
  if (mapping.jurisdiction && row[mapping.jurisdiction]?.trim()) {
    result.jurisdiction = row[mapping.jurisdiction].trim();
  }
  if (Object.keys(metadata).length > 0) {
    result.metadata = metadata;
  }

  return result;
}

// ─── STEP Components ────────────────────────────────────────

const WIZARD_STEPS: { key: WizardStep; label: string }[] = [
  { key: 'upload', label: 'Upload' },
  { key: 'mapping', label: 'Map Columns' },
  { key: 'preview', label: 'Preview' },
  { key: 'processing', label: 'Processing' },
  { key: 'results', label: 'Results' },
];

export function BulkIssuanceWizard({ open, onOpenChange, orgName }: Readonly<Props>) {
  const [step, setStep] = useState<WizardStep>('upload');
  const [parsedCsv, setParsedCsv] = useState<ParsedCsv | null>(null);
  const [mapping, setMapping] = useState<AttestationColumnMapping | null>(null);
  const [mappedRows, setMappedRows] = useState<MappedRow[]>([]);
  const [removedIndices, setRemovedIndices] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Processing state
  const [progress, setProgress] = useState(0);
  const [processedCount, setProcessedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [batchResults, setBatchResults] = useState<BatchResultItem[]>([]);
  const [batchSummary, setBatchSummary] = useState<BatchSummary | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const currentStepIndex = WIZARD_STEPS.findIndex((s) => s.key === step);

  const reset = useCallback(() => {
    setStep('upload');
    setParsedCsv(null);
    setMapping(null);
    setMappedRows([]);
    setRemovedIndices(new Set());
    setError(null);
    setProgress(0);
    setProcessedCount(0);
    setTotalCount(0);
    setBatchResults([]);
    setBatchSummary(null);
  }, []);

  const handleClose = useCallback(() => {
    if (step === 'processing') return; // Prevent closing during processing
    reset();
    onOpenChange(false);
  }, [step, reset, onOpenChange]);

  // ─── Step 1: Upload ──────────────────────────────────────

  const handleFileSelect = useCallback(async (file: File) => {
    setError(null);
    try {
      const csv = await parseCsvFile(file);
      if (csv.rows.length === 0) {
        setError('CSV file is empty or has no data rows.');
        return;
      }
      if (csv.rows.length > 10000) {
        setError('CSV file exceeds the maximum of 10,000 rows.');
        return;
      }
      setParsedCsv(csv);
      const detected = autoDetectAttestationMapping(csv.columns);
      setMapping(detected);
      setStep('mapping');
    } catch {
      setError('Failed to parse CSV file. Please check the format.');
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && (file.name.endsWith('.csv') || file.type === 'text/csv')) {
      handleFileSelect(file);
    } else {
      setError('Please upload a CSV file.');
    }
  }, [handleFileSelect]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
  }, [handleFileSelect]);

  // ─── Step 2: Mapping ─────────────────────────────────────

  const handleMappingChange = useCallback((field: keyof AttestationColumnMapping, value: string | null) => {
    setMapping((prev) => prev ? { ...prev, [field]: value } : prev);
  }, []);

  const handleMappingNext = useCallback(() => {
    if (!parsedCsv || !mapping) return;
    if (!mapping.subject_identifier) {
      setError('Subject identifier column mapping is required.');
      return;
    }
    setError(null);

    // Build mapped rows
    const rows: MappedRow[] = parsedCsv.rows.map((row) => {
      try {
        const attestation = buildAttestationFromRow(row.data, mapping, orgName);
        if (!attestation) {
          return { rowNumber: row.rowNumber, data: row.data, attestation: null, error: 'Subject identifier is empty' };
        }
        return { rowNumber: row.rowNumber, data: row.data, attestation, error: null };
      } catch (err) {
        return { rowNumber: row.rowNumber, data: row.data, attestation: null, error: err instanceof Error ? err.message : 'Mapping error' };
      }
    });

    setMappedRows(rows);
    setRemovedIndices(new Set());
    setStep('preview');
  }, [parsedCsv, mapping, orgName]);

  // ─── Step 3: Preview ─────────────────────────────────────

  const validRows = mappedRows.filter((r, i) => r.attestation && !r.error && !removedIndices.has(i));
  const invalidRows = mappedRows.filter((r, i) => (!r.attestation || r.error) && !removedIndices.has(i));

  const handleRemoveRow = useCallback((index: number) => {
    setRemovedIndices((prev) => new Set(prev).add(index));
  }, []);

  // ─── Step 4: Processing ──────────────────────────────────

  const handleProcess = useCallback(async () => {
    const toProcess = validRows.map((r) => r.attestation!);
    if (toProcess.length === 0) return;

    setStep('processing');
    setError(null);
    setTotalCount(toProcess.length);
    setProcessedCount(0);
    setProgress(0);

    const allResults: BatchResultItem[] = [];
    let totalCreated = 0;
    let totalFailed = 0;
    const BATCH_SIZE = 100;

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setError('Authentication required. Please sign in again.');
        setStep('preview');
        return;
      }

      for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
        const batch = toProcess.slice(i, i + BATCH_SIZE);

        const response = await fetch(`${WORKER_URL}/api/v1/attestations/batch-create`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ attestations: batch }),
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: 'Request failed' }));
          // Mark entire batch as failed
          for (let j = 0; j < batch.length; j++) {
            allResults.push({ index: i + j, error: err.error || 'Request failed' });
            totalFailed++;
          }
        } else {
          const result = await response.json();
          for (const item of result.results) {
            allResults.push({ ...item, index: i + item.index });
          }
          totalCreated += result.summary.created;
          totalFailed += result.summary.failed;
        }

        const processed = Math.min(i + BATCH_SIZE, toProcess.length);
        setProcessedCount(processed);
        setProgress(Math.round((processed / toProcess.length) * 100));
      }

      setBatchResults(allResults);
      setBatchSummary({ total: toProcess.length, created: totalCreated, failed: totalFailed });
      setStep('results');
    } catch {
      setError('Network error during processing. Some attestations may have been created.');
      setBatchResults(allResults);
      setBatchSummary({ total: toProcess.length, created: totalCreated, failed: totalFailed });
      setStep('results');
    }
  }, [validRows]);

  // ─── Step 5: Results ─────────────────────────────────────

  const handleDownloadResults = useCallback(() => {
    if (!batchResults.length) return;
    const headers = ['index', 'public_id', 'status', 'fingerprint', 'verify_url', 'error'];
    const csvRows = batchResults.map((r) => [
      r.index,
      r.public_id ?? '',
      r.status ?? '',
      r.fingerprint ?? '',
      r.public_id ? `https://app.arkova.io/verify/attestation/${r.public_id}` : '',
      r.error ?? '',
    ]);
    const csvContent = [headers.join(','), ...csvRows.map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `attestation-results-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }, [batchResults]);

  // ─── Render ──────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto bg-[#0a0e1a] border-[#1e293b] text-white">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-white">
            <FileSpreadsheet className="h-5 w-5 text-[#00d4ff]" />
            Bulk Issuance
          </DialogTitle>
          <DialogDescription className="text-[#94a3b8]">
            Issue multiple credential attestations from a CSV file
          </DialogDescription>
        </DialogHeader>

        {/* Progress Steps */}
        <div className="flex items-center justify-between px-2 py-3">
          {WIZARD_STEPS.map((s, index) => (
            <div key={s.key} className="flex items-center">
              <div
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium',
                  index <= currentStepIndex
                    ? 'bg-[#00d4ff] text-[#0a0e1a]'
                    : 'bg-[#1e293b] text-[#64748b]'
                )}
              >
                {index < currentStepIndex ? <CheckCircle className="h-3.5 w-3.5" /> : index + 1}
              </div>
              {index < WIZARD_STEPS.length - 1 && (
                <div className={cn('h-0.5 w-8 mx-1', index < currentStepIndex ? 'bg-[#00d4ff]' : 'bg-[#1e293b]')} />
              )}
            </div>
          ))}
        </div>
        <div className="flex justify-between px-2 mb-2">
          {WIZARD_STEPS.map((s) => (
            <span key={s.key} className={cn('text-[10px]', s.key === step ? 'text-white font-medium' : 'text-[#64748b]')}>
              {s.label}
            </span>
          ))}
        </div>

        {error && (
          <Alert variant="destructive" className="border-red-500/20 bg-red-500/10">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Step 1: Upload */}
        {step === 'upload' && (
          <div className="space-y-4">
            <div
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={() => fileInputRef.current?.click()}
              className="flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-[#1e293b] hover:border-[#00d4ff]/40 bg-[#0d141b] p-8 cursor-pointer transition-colors"
            >
              <Upload className="h-10 w-10 text-[#64748b]" />
              <div className="text-center">
                <p className="text-sm font-medium text-white">Drop your CSV file here or click to browse</p>
                <p className="text-xs text-[#64748b] mt-1">Supports .csv files up to 10,000 rows</p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                onChange={handleFileInput}
                className="hidden"
              />
            </div>

            <div className="flex items-center gap-4">
              <div className="h-px flex-1 bg-[#1e293b]" />
              <span className="text-xs text-[#64748b]">Or use a template</span>
              <div className="h-px flex-1 bg-[#1e293b]" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => downloadTemplate(EMPLOYMENT_HEADERS, 'arkova-employment-template.csv')}
                className="flex items-center gap-3 rounded-lg border border-[#1e293b] hover:border-[#00d4ff]/30 bg-[#0d141b] p-4 text-left transition-colors"
              >
                <Download className="h-5 w-5 text-[#00d4ff] shrink-0" />
                <div>
                  <p className="text-sm font-medium text-white">Employment Verification</p>
                  <p className="text-xs text-[#64748b]">Employee name, title, dates, status</p>
                </div>
              </button>
              <button
                onClick={() => downloadTemplate(EDUCATION_HEADERS, 'arkova-education-template.csv')}
                className="flex items-center gap-3 rounded-lg border border-[#1e293b] hover:border-[#00d4ff]/30 bg-[#0d141b] p-4 text-left transition-colors"
              >
                <Download className="h-5 w-5 text-[#00d4ff] shrink-0" />
                <div>
                  <p className="text-sm font-medium text-white">Education Verification</p>
                  <p className="text-xs text-[#64748b]">Student name, degree, institution</p>
                </div>
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Column Mapping */}
        {step === 'mapping' && parsedCsv && mapping && (
          <div className="space-y-4">
            <p className="text-xs text-[#94a3b8]">
              Map your CSV columns to attestation fields. Auto-detected mappings are pre-filled.
              {parsedCsv.totalRows} rows detected.
            </p>

            <div className="space-y-2 max-h-[50vh] overflow-y-auto">
              {([
                { key: 'subject_identifier' as const, label: 'Subject Identifier', required: true },
                { key: 'attestation_type' as const, label: 'Attestation Type' },
                { key: 'attester_name' as const, label: 'Attester Name' },
                { key: 'attester_type' as const, label: 'Attester Type' },
                { key: 'summary' as const, label: 'Summary' },
                { key: 'expires_at' as const, label: 'Expiration Date' },
                { key: 'jurisdiction' as const, label: 'Jurisdiction' },
                { key: 'title' as const, label: 'Job Title (Employment)' },
                { key: 'department' as const, label: 'Department (Employment)' },
                { key: 'start_date' as const, label: 'Start Date (Employment)' },
                { key: 'end_date' as const, label: 'End Date (Employment)' },
                { key: 'employment_status' as const, label: 'Status (Employment)' },
                { key: 'degree_type' as const, label: 'Degree Type (Education)' },
                { key: 'field_of_study' as const, label: 'Field of Study (Education)' },
                { key: 'institution' as const, label: 'Institution (Education)' },
                { key: 'graduation_date' as const, label: 'Graduation Date (Education)' },
                { key: 'gpa' as const, label: 'GPA (Education)' },
                { key: 'honors' as const, label: 'Honors (Education)' },
              ]).map(({ key, label, required }) => (
                <div key={key} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-[#0d141b]">
                  <span className="text-sm text-[#94a3b8]">
                    {label}
                    {required && <span className="text-red-400 ml-1">*</span>}
                  </span>
                  <Select
                    value={mapping[key] ?? '__none__'}
                    onValueChange={(v) => handleMappingChange(key, v === '__none__' ? null : v)}
                  >
                    <SelectTrigger className="w-48 h-8 text-xs bg-[#0d141b] border-[#1e293b]">
                      <SelectValue placeholder="Not mapped" />
                    </SelectTrigger>
                    <SelectContent className="bg-[#0d141b] border-[#1e293b]">
                      <SelectItem value="__none__">Not mapped</SelectItem>
                      {parsedCsv.columns.map((col) => (
                        <SelectItem key={col.name} value={col.name}>{col.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>

            <div className="flex justify-between pt-2">
              <Button variant="outline" size="sm" onClick={() => { setStep('upload'); setError(null); }} className="border-[#1e293b]">
                <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Back
              </Button>
              <Button size="sm" onClick={handleMappingNext} className="bg-[#00d4ff] text-[#0a0e1a] hover:bg-[#00d4ff]/90">
                Preview <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 3: Preview & Validate */}
        {step === 'preview' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-center">
                <div className="text-2xl font-bold text-emerald-400">{validRows.length}</div>
                <p className="text-xs text-[#94a3b8]">Valid records</p>
              </div>
              <div className={cn('rounded-lg border p-3 text-center', invalidRows.length > 0 ? 'border-red-500/20 bg-red-500/5' : 'border-[#1e293b]')}>
                <div className={cn('text-2xl font-bold', invalidRows.length > 0 ? 'text-red-400' : 'text-[#64748b]')}>{invalidRows.length}</div>
                <p className="text-xs text-[#94a3b8]">Invalid records</p>
              </div>
            </div>

            {/* Preview Table */}
            <div className="rounded-lg border border-[#1e293b] overflow-hidden max-h-[300px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-[#1e293b] hover:bg-transparent">
                    <TableHead className="text-xs text-[#64748b] w-12">Row</TableHead>
                    <TableHead className="text-xs text-[#64748b]">Subject</TableHead>
                    <TableHead className="text-xs text-[#64748b]">Type</TableHead>
                    <TableHead className="text-xs text-[#64748b]">Claims</TableHead>
                    <TableHead className="text-xs text-[#64748b] w-16">Status</TableHead>
                    <TableHead className="text-xs text-[#64748b] w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mappedRows.slice(0, 50).map((row, idx) => {
                    if (removedIndices.has(idx)) return null;
                    const isInvalid = !row.attestation || !!row.error;
                    return (
                      <TableRow
                        key={row.rowNumber}
                        className={cn('border-[#1e293b]', isInvalid ? 'bg-red-500/5' : 'hover:bg-[#0d141b]')}
                      >
                        <TableCell className="text-xs font-mono text-[#64748b]">{row.rowNumber}</TableCell>
                        <TableCell className="text-xs text-white truncate max-w-[150px]">
                          {row.attestation?.subject_identifier ?? '-'}
                        </TableCell>
                        <TableCell className="text-xs">
                          {row.attestation ? (
                            <Badge variant="outline" className="text-[10px] border-[#1e293b]">{row.attestation.attestation_type}</Badge>
                          ) : '-'}
                        </TableCell>
                        <TableCell className="text-xs text-[#94a3b8]">
                          {row.attestation?.claims.length ?? 0} claims
                        </TableCell>
                        <TableCell>
                          {isInvalid ? (
                            <Badge variant="destructive" className="text-[10px]">Error</Badge>
                          ) : (
                            <Badge className="text-[10px] bg-emerald-500/10 text-emerald-400 border-emerald-500/20">Valid</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <button
                            onClick={() => handleRemoveRow(idx)}
                            className="text-[#64748b] hover:text-red-400 transition-colors"
                            title="Remove row"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {mappedRows.length > 50 && (
                <div className="px-4 py-2 text-xs text-[#64748b] border-t border-[#1e293b]">
                  Showing first 50 of {mappedRows.length} rows
                </div>
              )}
            </div>

            {/* Error details */}
            {invalidRows.length > 0 && (
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle className="h-4 w-4 text-amber-400" />
                  <span className="text-sm font-medium text-amber-400">Validation Issues</span>
                </div>
                <div className="space-y-1 max-h-[100px] overflow-y-auto">
                  {invalidRows.slice(0, 10).map((row) => (
                    <p key={row.rowNumber} className="text-xs text-[#94a3b8]">
                      Row {row.rowNumber}: {row.error ?? 'Invalid data'}
                    </p>
                  ))}
                  {invalidRows.length > 10 && (
                    <p className="text-xs text-[#64748b]">And {invalidRows.length - 10} more...</p>
                  )}
                </div>
              </div>
            )}

            <div className="flex justify-between pt-2">
              <Button variant="outline" size="sm" onClick={() => setStep('mapping')} className="border-[#1e293b]">
                <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Back
              </Button>
              <Button
                size="sm"
                onClick={handleProcess}
                disabled={validRows.length === 0}
                className="bg-[#00d4ff] text-[#0a0e1a] hover:bg-[#00d4ff]/90"
              >
                Issue {validRows.length} Attestations <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 4: Processing */}
        {step === 'processing' && (
          <div className="space-y-4 py-6">
            <div className="flex justify-center">
              <Loader2 className="h-10 w-10 animate-spin text-[#00d4ff]" />
            </div>
            <div className="text-center space-y-2">
              <p className="font-medium text-white">Issuing attestations...</p>
              <p className="text-sm text-[#94a3b8]">
                {processedCount} of {totalCount} records processed
              </p>
            </div>
            <Progress value={progress} className="w-full" />
            <p className="text-xs text-center text-[#64748b]">
              Please do not close this window
            </p>
          </div>
        )}

        {/* Step 5: Results */}
        {step === 'results' && batchSummary && (
          <div className="space-y-4">
            <div className="flex justify-center py-2">
              <div className={cn(
                'flex h-14 w-14 items-center justify-center rounded-full',
                batchSummary.failed > 0 ? 'bg-amber-500/10' : 'bg-emerald-500/10'
              )}>
                {batchSummary.failed > 0 ? (
                  <AlertTriangle className="h-7 w-7 text-amber-400" />
                ) : (
                  <CheckCircle className="h-7 w-7 text-emerald-400" />
                )}
              </div>
            </div>

            <div className="text-center">
              <h3 className="text-lg font-semibold text-white">
                {batchSummary.failed > 0 ? 'Issuance Completed with Issues' : 'Issuance Complete'}
              </h3>
              <p className="text-sm text-[#94a3b8]">
                Your attestations have been processed.
              </p>
            </div>

            <div className="flex justify-center gap-3 pt-1">
              <Badge className="text-sm px-3 py-1 bg-emerald-600 hover:bg-emerald-600">
                {batchSummary.created} Issued
              </Badge>
              {batchSummary.failed > 0 && (
                <Badge variant="destructive" className="text-sm px-3 py-1">
                  {batchSummary.failed} Failed
                </Badge>
              )}
            </div>

            <div className="flex justify-center gap-3 pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownloadResults}
                className="border-[#1e293b]"
              >
                <Download className="mr-1 h-3.5 w-3.5" /> Download Results CSV
              </Button>
              <Button
                size="sm"
                onClick={() => { reset(); onOpenChange(false); }}
                className="bg-[#00d4ff] text-[#0a0e1a] hover:bg-[#00d4ff]/90"
              >
                Done
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
