/**
 * CLE Bulk Import Component
 *
 * CSV upload for CLE providers to submit multiple course completions at once.
 * Expected CSV columns:
 *   bar_number, attorney_name (optional), course_title, provider_name,
 *   credit_hours, credit_category, jurisdiction, completion_date,
 *   course_number (optional), delivery_method (optional)
 *
 * Each row creates a CLE anchor via the worker /api/v1/cle/submit endpoint.
 */

import { useState, useCallback } from 'react';
import {
  FileSpreadsheet,
  Upload,
  CheckCircle,
  AlertCircle,
  Loader2,
  Download,
  Scale,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { supabase } from '@/lib/supabase';
import { WORKER_URL } from '@/lib/workerClient';
import { toast } from 'sonner';

interface CleRow {
  bar_number: string;
  attorney_name?: string;
  course_title: string;
  provider_name: string;
  credit_hours: number;
  credit_category: string;
  jurisdiction: string;
  completion_date: string;
  course_number?: string;
  delivery_method?: string;
}

interface ImportResult {
  total: number;
  submitted: number;
  failed: number;
  errors: Array<{ row: number; error: string }>;
}

type Step = 'upload' | 'review' | 'importing' | 'complete';

const VALID_CATEGORIES = [
  'General', 'Ethics', 'Professional Responsibility', 'Substance Abuse',
  'Diversity', 'Technology', 'Mental Health', 'Elimination of Bias',
];

const VALID_METHODS = [
  'Live In-Person', 'Live Webcast', 'On-Demand', 'Self-Study', 'Hybrid',
];

const REQUIRED_COLUMNS = ['bar_number', 'course_title', 'provider_name', 'credit_hours', 'credit_category', 'jurisdiction', 'completion_date'];

interface CleBulkImportProps {
  onComplete?: () => void;
  onCancel?: () => void;
}

export function CleBulkImport({ onComplete, onCancel }: Readonly<CleBulkImportProps>) {
  const [step, setStep] = useState<Step>('upload');
  const [rows, setRows] = useState<CleRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [progress, setProgress] = useState(0);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      const parsed = parseCsv(text);
      if (parsed.errors.length > 0) {
        setErrors(parsed.errors);
      } else {
        setRows(parsed.rows);
        setErrors([]);
        setStep('review');
      }
    };
    reader.readAsText(file);
  }, []);

  const handleImport = useCallback(async () => {
    if (rows.length === 0) return;

    setStep('importing');
    setProgress(0);

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      toast.error('Authentication required');
      setStep('review');
      return;
    }

    const workerUrl = import.meta.env.VITE_WORKER_URL ?? WORKER_URL;
    let submitted = 0;
    let failed = 0;
    const importErrors: Array<{ row: number; error: string }> = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const response = await fetch(`${workerUrl}/api/v1/cle/submit`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify(row),
        });

        if (response.ok) {
          submitted++;
        } else {
          const err = await response.json().catch(() => ({ error: 'Unknown error' }));
          failed++;
          importErrors.push({ row: i + 2, error: (err as Record<string, string>).error ?? 'Submission failed' });
        }
      } catch {
        failed++;
        importErrors.push({ row: i + 2, error: 'Network error' });
      }

      setProgress(Math.round(((i + 1) / rows.length) * 100));
    }

    setResult({ total: rows.length, submitted, failed, errors: importErrors });
    setStep('complete');
    toast.success(`${submitted} CLE credits submitted for anchoring`);
  }, [rows]);

  const handleDownloadTemplate = useCallback(() => {
    const csv = [
      'bar_number,attorney_name,course_title,provider_name,credit_hours,credit_category,jurisdiction,completion_date,course_number,delivery_method',
      '12345,Jane Doe,Advanced Ethics in Digital Practice,National Legal Academy,3.0,Ethics,California,2026-03-15,CLE-2026-001,Live Webcast',
      '67890,John Smith,Civil Litigation Update 2026,State Bar Association,2.0,General,New York,2026-03-10,CLE-2026-002,Live In-Person',
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cle_import_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  return (
    <div className="space-y-4">
      {step === 'upload' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Scale className="h-5 w-5" />
              CLE Bulk Import
            </CardTitle>
            <CardDescription>
              Upload a CSV file with CLE course completions. Each row will be anchored as a verified CLE credit.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-8 text-center">
              <FileSpreadsheet className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground mb-4">
                Upload a CSV with columns: bar_number, course_title, provider_name, credit_hours, credit_category, jurisdiction, completion_date
              </p>
              <div className="flex gap-2 justify-center">
                <Button variant="outline" size="sm" asChild>
                  <label className="cursor-pointer">
                    <Upload className="mr-2 h-4 w-4" />
                    Select CSV File
                    <input
                      type="file"
                      accept=".csv"
                      className="hidden"
                      onChange={handleFileUpload}
                    />
                  </label>
                </Button>
                <Button variant="ghost" size="sm" onClick={handleDownloadTemplate}>
                  <Download className="mr-2 h-4 w-4" />
                  Download Template
                </Button>
              </div>
            </div>

            {errors.length > 0 && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  <ul className="list-disc list-inside space-y-1">
                    {errors.map((err, i) => (
                      <li key={`err-${i}`} className="text-xs">{err}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            {onCancel && (
              <Button variant="outline" onClick={onCancel} className="w-full">Cancel</Button>
            )}
          </CardContent>
        </Card>
      )}

      {step === 'review' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Scale className="h-5 w-5" />
              Review CLE Credits
              <Badge variant="secondary">{rows.length} records</Badge>
            </CardTitle>
            <CardDescription>
              Verify the data below, then click Import to submit all credits for anchoring.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="max-h-[400px] overflow-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Bar #</TableHead>
                    <TableHead className="text-xs">Course</TableHead>
                    <TableHead className="text-xs">Hours</TableHead>
                    <TableHead className="text-xs">Category</TableHead>
                    <TableHead className="text-xs">State</TableHead>
                    <TableHead className="text-xs">Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.slice(0, 50).map((row, i) => (
                    <TableRow key={`row-${i}`}>
                      <TableCell className="text-xs font-mono">{row.bar_number}</TableCell>
                      <TableCell className="text-xs max-w-[200px] truncate">{row.course_title}</TableCell>
                      <TableCell className="text-xs">{row.credit_hours}</TableCell>
                      <TableCell className="text-xs">
                        <Badge variant="outline" className="text-[10px]">{row.credit_category}</Badge>
                      </TableCell>
                      <TableCell className="text-xs">{row.jurisdiction}</TableCell>
                      <TableCell className="text-xs">{row.completion_date}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {rows.length > 50 && (
                <p className="text-xs text-muted-foreground p-2 text-center">
                  Showing first 50 of {rows.length} rows
                </p>
              )}
            </div>

            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep('upload')}>Back</Button>
              <Button onClick={handleImport} className="flex-1">
                <Scale className="mr-2 h-4 w-4" />
                Import {rows.length} CLE Credits
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'importing' && (
        <Card>
          <CardContent className="py-8 space-y-4 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto" />
            <p className="text-sm font-medium">Submitting CLE credits for anchoring...</p>
            <Progress value={progress} className="max-w-xs mx-auto" />
            <p className="text-xs text-muted-foreground">{progress}% complete</p>
          </CardContent>
        </Card>
      )}

      {step === 'complete' && result && (
        <Card>
          <CardContent className="py-8 space-y-4">
            <div className="text-center">
              <CheckCircle className="h-12 w-12 text-green-500 mx-auto mb-3" />
              <h3 className="text-lg font-semibold">Import Complete</h3>
              <p className="text-sm text-muted-foreground mt-1">
                {result.submitted} of {result.total} CLE credits submitted for anchoring
              </p>
            </div>

            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-2xl font-bold text-green-500">{result.submitted}</p>
                <p className="text-xs text-muted-foreground">Submitted</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-red-500">{result.failed}</p>
                <p className="text-xs text-muted-foreground">Failed</p>
              </div>
              <div>
                <p className="text-2xl font-bold">{result.total}</p>
                <p className="text-xs text-muted-foreground">Total</p>
              </div>
            </div>

            {result.errors.length > 0 && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  <p className="font-medium mb-1">{result.errors.length} errors:</p>
                  <ul className="list-disc list-inside space-y-1 max-h-32 overflow-auto">
                    {result.errors.map((err, i) => (
                      <li key={`import-err-${i}`} className="text-xs">Row {err.row}: {err.error}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            <Button onClick={onComplete} className="w-full">Done</Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── CSV Parser ─────────────────────────────────────────────────────────────

function parseCsv(text: string): { rows: CleRow[]; errors: string[] } {
  const lines = text.trim().split('\n');
  if (lines.length < 2) {
    return { rows: [], errors: ['CSV must have at least a header row and one data row'] };
  }

  const header = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/['"]/g, ''));
  const errors: string[] = [];

  // Validate required columns
  for (const col of REQUIRED_COLUMNS) {
    if (!header.includes(col)) {
      errors.push(`Missing required column: ${col}`);
    }
  }
  if (errors.length > 0) return { rows: [], errors };

  const rows: CleRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseCSVLine(line);
    const record: Record<string, string> = {};
    header.forEach((col, j) => { record[col] = (values[j] ?? '').trim(); });

    // Validate row
    const rowErrors: string[] = [];
    if (!record.bar_number) rowErrors.push('bar_number is required');
    if (!record.course_title) rowErrors.push('course_title is required');
    if (!record.provider_name) rowErrors.push('provider_name is required');
    if (!record.credit_hours || isNaN(Number(record.credit_hours))) rowErrors.push('credit_hours must be a number');
    if (!record.credit_category) rowErrors.push('credit_category is required');
    if (!record.jurisdiction) rowErrors.push('jurisdiction is required');
    if (!record.completion_date || !/^\d{4}-\d{2}-\d{2}$/.test(record.completion_date)) {
      rowErrors.push('completion_date must be YYYY-MM-DD format');
    }

    if (rowErrors.length > 0) {
      errors.push(`Row ${i + 1}: ${rowErrors.join(', ')}`);
      continue;
    }

    rows.push({
      bar_number: record.bar_number,
      attorney_name: record.attorney_name || undefined,
      course_title: record.course_title,
      provider_name: record.provider_name,
      credit_hours: Number(record.credit_hours),
      credit_category: VALID_CATEGORIES.includes(record.credit_category)
        ? record.credit_category
        : 'General',
      jurisdiction: record.jurisdiction,
      completion_date: record.completion_date,
      course_number: record.course_number || undefined,
      delivery_method: VALID_METHODS.includes(record.delivery_method ?? '')
        ? record.delivery_method
        : undefined,
    });
  }

  return { rows, errors };
}

/** Parse a single CSV line handling quoted fields */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}
