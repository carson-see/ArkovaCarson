/**
 * AI Extraction Step (BETA-06)
 *
 * Inserted into the BulkUploadWizard between review and processing.
 * Sends rows to the batch extraction endpoint and displays results.
 *
 * Constitution 4A: Row text is assembled client-side from spreadsheet data
 * (no raw documents). Only structured text flows to server.
 */

import { useState, useCallback } from 'react';
import { Sparkles, ArrowLeft, ArrowRight, Loader2, AlertCircle, CheckCircle, SkipForward } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/lib/supabase';
import type { CsvColumn, CsvRow, ColumnMapping } from '@/lib/csvParser';

export interface BatchExtractionResult {
  index: number;
  success: boolean;
  fields?: Record<string, string>;
  confidence?: number;
  provider?: string;
  error?: string;
}

interface AIExtractionStepProps {
  rows: CsvRow[];
  columns: CsvColumn[];
  mapping: ColumnMapping;
  onComplete: (results: BatchExtractionResult[]) => void;
  onBack: () => void;
  onSkip: () => void;
}

type ExtractionState = 'idle' | 'extracting' | 'complete' | 'error';

export function AIExtractionStep({
  rows,
  columns,
  mapping,
  onComplete,
  onBack,
  onSkip,
}: Readonly<AIExtractionStepProps>) {
  const [state, setState] = useState<ExtractionState>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<BatchExtractionResult[] | null>(null);

  const buildRowText = useCallback(
    (row: CsvRow): string => {
      return columns
        .map((col) => {
          const value = row.data[col.name] ?? '';
          return `${col.name}: ${value}`;
        })
        .filter((line) => !line.endsWith(': '))
        .join('\n');
    },
    [columns]
  );

  const inferCredentialType = useCallback(
    (row: CsvRow): string => {
      if (mapping.credentialType !== null) {
        const colName = columns[mapping.credentialType]?.name;
        if (colName && row.data[colName]) {
          return row.data[colName];
        }
      }
      return 'OTHER';
    },
    [mapping, columns]
  );

  const handleExtract = useCallback(async () => {
    setState('extracting');
    setProgress(10);
    setError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setError('Authentication required');
        setState('error');
        return;
      }

      // Build batch request
      const batchRows = rows.map((row) => ({
        text: buildRowText(row),
        credentialType: inferCredentialType(row),
      }));

      setProgress(30);

      const workerUrl = import.meta.env.VITE_WORKER_URL ?? 'http://localhost:3001';
      const response = await fetch(`${workerUrl}/api/v1/ai/extract-batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ rows: batchRows }),
      });

      setProgress(80);

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        const message = (errorBody as Record<string, string>).message ?? `Extraction failed (${response.status})`;
        setError(message);
        setState('error');
        return;
      }

      const data = await response.json() as {
        results: BatchExtractionResult[];
        summary: { total: number; succeeded: number; failed: number };
        creditsRemaining: number;
      };

      setResults(data.results);
      setProgress(100);
      setState('complete');
      onComplete(data.results);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Extraction failed';
      setError(message);
      setState('error');
    }
  }, [rows, buildRowText, inferCredentialType, onComplete]);

  const succeededCount = results?.filter((r) => r.success).length ?? 0;
  const failedCount = results?.filter((r) => !r.success).length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-xl bg-gradient-to-br from-primary/15 to-primary/5">
          <Sparkles className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h3 className="font-semibold text-sm">AI Extraction</h3>
          <p className="text-xs text-muted-foreground">
            Analyze {rows.length} rows to extract credential metadata
          </p>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {state === 'extracting' && (
        <div className="space-y-3 py-4">
          <div className="flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
          <p className="text-sm text-center text-muted-foreground">
            Analyzing {rows.length} rows...
          </p>
          <Progress value={progress} className="w-full" />
        </div>
      )}

      {state === 'complete' && results && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-5 w-5 text-green-600" />
            <span className="text-sm font-medium">Extraction Complete</span>
          </div>
          <div className="flex gap-2">
            <Badge variant="default" className="bg-green-600">
              {succeededCount} extracted
            </Badge>
            {failedCount > 0 && (
              <Badge variant="destructive">
                {failedCount} failed
              </Badge>
            )}
          </div>
        </div>
      )}

      {state === 'idle' && (
        <div className="rounded-lg border p-4 bg-muted/30">
          <p className="text-sm text-muted-foreground">
            AI will analyze each row to extract credential type, issuer, dates, and other metadata.
            This uses 1 credit per row ({rows.length} credits total).
          </p>
        </div>
      )}

      <div className="flex justify-between pt-4">
        <Button variant="outline" onClick={onBack} disabled={state === 'extracting'}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onSkip} disabled={state === 'extracting'}>
            <SkipForward className="mr-2 h-4 w-4" />
            Skip
          </Button>
          {state === 'idle' && (
            <Button onClick={handleExtract}>
              <Sparkles className="mr-2 h-4 w-4" />
              Extract ({rows.length} rows)
            </Button>
          )}
          {state === 'error' && (
            <Button onClick={handleExtract}>
              Try Again
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
