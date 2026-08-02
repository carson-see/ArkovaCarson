/**
 * Mixed-Format Batch Upload Wizard (SCRUM-2911 W1, founder P0 2026-07-28)
 *
 * Secures a batch of files of ANY type in one action — the dashboard
 * counterpart to `BulkUploadWizard`, which stays CSV-row-only per the sprint
 * plan ("don't overload BulkUploadWizard"). Each file is fingerprinted
 * client-side (§1.6 — `generateFingerprint`, browser-only), then the
 * fingerprint array (never raw file content) is submitted to the worker's
 * `POST /api/v1/anchor/bulk/self-service` bridge, which delegates into the
 * existing `/api/v1/anchor/bulk` dedup/credit/quota/insert pipeline.
 *
 * §1.6 boundary: no `File`/`Blob`/`ArrayBuffer` is ever passed to `fetch` —
 * only the fingerprint string + filename + a coarse document-type string
 * derived from the file extension leave the browser.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Files,
  CheckCircle,
  AlertCircle,
  Loader2,
  Copy as CopyIcon,
  X,
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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { generateFingerprint } from '@/lib/fileHasher';
import { workerFetch } from '@/lib/workerClient';
import { MIXED_BATCH_LABELS } from '@/lib/copy';
import { toast } from 'sonner';

/** Up to 1000 rows per POST (matches the server's BulkAnchorRequestSchema cap); chunk larger selections. */
const SUBMIT_CHUNK_SIZE = 200;
/** Bound concurrent client-side fingerprinting so a huge batch doesn't stall the main thread. */
const HASH_CONCURRENCY = 4;

type FileStatus = 'pending' | 'fingerprinting' | 'fingerprinted' | 'fingerprint-failed';

interface TrackedFile {
  file: File;
  status: FileStatus;
  fingerprint?: string;
  error?: string;
}

export interface MixedBatchFileResult {
  fileName: string;
  status: 'success' | 'duplicate' | 'failed';
  publicId?: string;
  message?: string;
}

export interface MixedBatchResult {
  total: number;
  succeeded: number;
  duplicates: number;
  failed: number;
  results: MixedBatchFileResult[];
}

type Phase = 'fingerprinting' | 'submitting' | 'complete' | 'blocked' | 'error';

interface BulkAnchorApiRow {
  fingerprint: string;
  filename: string;
  document_type: string;
}

interface BulkAnchorApiResponse {
  queued: number;
  duplicates: Array<{ row: number; fingerprint: string }>;
  errors: Array<{ row: number; message: string }>;
  anchors?: Array<{ public_id: string; fingerprint: string }>;
}

function extensionOf(name: string): string {
  const parts = name.toLowerCase().split('.');
  return parts.length > 1 ? (parts.pop() ?? 'unknown') : 'unknown';
}

/** Bounded-concurrency map — avoids saturating the main thread on large batches. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  shouldStop: () => boolean,
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      if (shouldStop()) return;
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

interface MixedBatchUploadWizardProps {
  files: File[];
  onComplete?: (result: MixedBatchResult) => void;
  onCancel?: () => void;
  // Deliberately NO `orgId` prop (unlike `BulkUploadWizard`): the worker's
  // `/api/v1/anchor/bulk/self-service` bridge always re-derives org_id from
  // the caller's `profiles` row server-side and never trusts a client-
  // supplied org — see anchor-bulk-self-service.ts.
}

export function MixedBatchUploadWizard({ files: initialFiles, onComplete, onCancel }: Readonly<MixedBatchUploadWizardProps>) {
  const [phase, setPhase] = useState<Phase>('fingerprinting');
  const [tracked, setTracked] = useState<TrackedFile[]>(
    () => initialFiles.map((file) => ({ file, status: 'pending' as const })),
  );
  const [result, setResult] = useState<MixedBatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const startedRef = useRef(false);

  const updateFile = useCallback((index: number, patch: Partial<TrackedFile>) => {
    setTracked((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }, []);

  const submitBatch = useCallback(async (hashed: Array<TrackedFile & { fingerprint: string }>, failedToHash: TrackedFile[]) => {
    setPhase('submitting');

    const allResults: MixedBatchFileResult[] = [];
    let succeeded = 0;
    let duplicates = 0;
    let failed = 0;

    try {
      for (let start = 0; start < hashed.length; start += SUBMIT_CHUNK_SIZE) {
        if (cancelledRef.current) return;
        const chunk = hashed.slice(start, start + SUBMIT_CHUNK_SIZE);

        // §1.6: only fingerprint + filename + a derived extension string leave
        // the browser — never the File/Blob/ArrayBuffer itself.
        const anchors: BulkAnchorApiRow[] = chunk.map((f) => ({
          fingerprint: f.fingerprint,
          filename: f.file.name.slice(0, 255),
          document_type: extensionOf(f.file.name),
        }));

        const res = await workerFetch('/api/v1/anchor/bulk/self-service', {
          method: 'POST',
          body: JSON.stringify({
            anchors,
            duplicate_strategy: 'skip',
            batch_id: `dashboard-${Date.now()}-${start}`,
          }),
        });

        if (!res.ok) {
          if (res.status === 403) {
            setPhase('blocked');
            return;
          }
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { message?: string }).message ?? MIXED_BATCH_LABELS.SUBMIT_FAILED);
        }

        const body = (await res.json()) as BulkAnchorApiResponse;
        const duplicateRows = new Map(body.duplicates.map((d) => [d.row, d]));
        const errorRows = new Map(body.errors.map((e) => [e.row, e]));
        const insertedByFingerprint = new Map(
          (body.anchors ?? []).map((a) => [a.fingerprint.toLowerCase(), a]),
        );

        chunk.forEach((f, i) => {
          if (errorRows.has(i)) {
            failed += 1;
            allResults.push({ fileName: f.file.name, status: 'failed', message: errorRows.get(i)!.message });
            return;
          }
          if (duplicateRows.has(i)) {
            duplicates += 1;
            allResults.push({ fileName: f.file.name, status: 'duplicate' });
            return;
          }
          succeeded += 1;
          const inserted = insertedByFingerprint.get(f.fingerprint.toLowerCase());
          allResults.push({ fileName: f.file.name, status: 'success', publicId: inserted?.public_id });
        });
      }

      // Hashing failures never reached the server — surface them as failed too,
      // so nothing that was dropped from the batch goes unexplained (per the
      // "duplicates/failures must be visible, not silently swallowed" bar).
      failedToHash.forEach((f) => {
        failed += 1;
        allResults.push({ fileName: f.file.name, status: 'failed', message: f.error ?? MIXED_BATCH_LABELS.FINGERPRINT_FAILED });
      });

      const finalResult: MixedBatchResult = {
        total: allResults.length,
        succeeded,
        duplicates,
        failed,
        results: allResults,
      };
      setResult(finalResult);
      setPhase('complete');
      onComplete?.(finalResult);
    } catch (err) {
      const message = err instanceof Error ? err.message : MIXED_BATCH_LABELS.NETWORK_ERROR;
      setError(message);
      setPhase('error');
      toast.error(message);
    }
  }, [onComplete]);

  const runFingerprinting = useCallback(async (filesToHash: TrackedFile[]) => {
    setPhase('fingerprinting');

    const updated = await mapWithConcurrency(
      filesToHash,
      HASH_CONCURRENCY,
      async (tf, index): Promise<TrackedFile> => {
        updateFile(index, { status: 'fingerprinting' });
        try {
          if (!globalThis.crypto?.subtle) {
            throw new Error('Secure context required — crypto.subtle is unavailable.');
          }
          const fingerprint = await generateFingerprint(tf.file);
          updateFile(index, { status: 'fingerprinted', fingerprint });
          return { ...tf, status: 'fingerprinted', fingerprint };
        } catch (err) {
          const message = err instanceof Error ? err.message : MIXED_BATCH_LABELS.FINGERPRINT_FAILED;
          updateFile(index, { status: 'fingerprint-failed', error: message });
          return { ...tf, status: 'fingerprint-failed', error: message };
        }
      },
      () => cancelledRef.current,
    );

    if (cancelledRef.current) return;

    const successfullyHashed = updated.filter(
      (f): f is TrackedFile & { fingerprint: string } =>
        Boolean(f) && f!.status === 'fingerprinted' && Boolean(f!.fingerprint),
    );
    const failedToHash = updated.filter(
      (f): f is TrackedFile => Boolean(f) && f!.status === 'fingerprint-failed',
    );

    if (successfullyHashed.length === 0) {
      setError(MIXED_BATCH_LABELS.NO_FILES_FINGERPRINTED);
      setPhase('error');
      return;
    }

    await submitBatch(successfullyHashed, failedToHash);
  }, [updateFile, submitBatch]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void runFingerprinting(initialFiles.map((file) => ({ file, status: 'pending' as const })));
    // Intentionally run exactly once on mount — `initialFiles`/`runFingerprinting`
    // are captured from the first render; the batch is fixed for this wizard instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCancel = useCallback(() => {
    cancelledRef.current = true;
    onCancel?.();
  }, [onCancel]);

  const fingerprintedCount = tracked.filter((f) => f.status === 'fingerprinted' || f.status === 'fingerprint-failed').length;
  const fingerprintProgress = tracked.length > 0 ? (fingerprintedCount / tracked.length) * 100 : 0;

  return (
    <Card className="max-w-2xl mx-auto border-0 shadow-none">
      <CardHeader className="px-0">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Files className="h-5 w-5" />
              {MIXED_BATCH_LABELS.TITLE}
            </CardTitle>
            <CardDescription>{MIXED_BATCH_LABELS.DESCRIPTION}</CardDescription>
          </div>
          {(phase === 'fingerprinting' || phase === 'submitting') && onCancel && (
            <Button variant="ghost" size="icon" onClick={handleCancel} aria-label={MIXED_BATCH_LABELS.CANCEL}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="px-0 space-y-4">
        {phase === 'fingerprinting' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span>{MIXED_BATCH_LABELS.FINGERPRINTING}</span>
              <span className="text-muted-foreground">
                {MIXED_BATCH_LABELS.FINGERPRINTING_COUNT
                  .replace('{done}', String(fingerprintedCount))
                  .replace('{total}', String(tracked.length))}
              </span>
            </div>
            <Progress value={fingerprintProgress} />
            <ul className="max-h-64 overflow-y-auto space-y-1 rounded-md border p-2" data-testid="fingerprint-file-list">
              {tracked.map((tf, i) => (
                <li key={`${tf.file.name}-${i}`} className="flex items-center gap-2 text-sm px-1 py-0.5">
                  {tf.status === 'fingerprinted' && <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />}
                  {tf.status === 'fingerprint-failed' && <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" />}
                  {(tf.status === 'pending' || tf.status === 'fingerprinting') && (
                    <Loader2 className={cn('h-3.5 w-3.5 shrink-0', tf.status === 'fingerprinting' && 'animate-spin text-primary')} />
                  )}
                  <span className="truncate">{tf.file.name}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {phase === 'submitting' && (
          <div className="flex flex-col items-center gap-3 py-6">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">
              {MIXED_BATCH_LABELS.SUBMITTING.replace('{count}', String(tracked.length))}
            </p>
          </div>
        )}

        {phase === 'blocked' && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{MIXED_BATCH_LABELS.ORG_REQUIRED}</AlertDescription>
          </Alert>
        )}

        {phase === 'error' && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {phase === 'complete' && result && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Badge variant="default" className="bg-green-600">
                {result.succeeded} {MIXED_BATCH_LABELS.SUMMARY_SECURED}
              </Badge>
              {result.duplicates > 0 && (
                <Badge variant="secondary">
                  {result.duplicates} {MIXED_BATCH_LABELS.SUMMARY_DUPLICATE}
                </Badge>
              )}
              {result.failed > 0 && (
                <Badge variant="destructive">
                  {result.failed} {MIXED_BATCH_LABELS.SUMMARY_FAILED}
                </Badge>
              )}
            </div>

            <div>
              <h4 className="text-sm font-medium mb-2">{MIXED_BATCH_LABELS.RESULTS_HEADING}</h4>
              <ul className="max-h-72 overflow-y-auto space-y-1 rounded-md border p-2" data-testid="mixed-batch-results">
                {result.results.map((r, i) => (
                  <li key={`${r.fileName}-${i}`} className="flex items-center justify-between gap-2 text-sm px-1 py-1">
                    <span className="flex items-center gap-2 truncate">
                      {r.status === 'success' && <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />}
                      {r.status === 'duplicate' && <CopyIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                      {r.status === 'failed' && <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" />}
                      <span className="truncate">{r.fileName}</span>
                    </span>
                    <span
                      className={cn(
                        'text-xs shrink-0',
                        r.status === 'success' && 'text-green-600',
                        r.status === 'duplicate' && 'text-muted-foreground',
                        r.status === 'failed' && 'text-destructive',
                      )}
                    >
                      {r.status === 'success' && MIXED_BATCH_LABELS.STATUS_SECURED}
                      {r.status === 'duplicate' && MIXED_BATCH_LABELS.STATUS_DUPLICATE}
                      {r.status === 'failed' && (r.message ?? MIXED_BATCH_LABELS.STATUS_FAILED)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </CardContent>

      {(phase === 'complete' || phase === 'error' || phase === 'blocked') && (
        <div className="flex justify-end gap-2 px-0 pt-2">
          <Button variant="outline" onClick={onCancel}>
            {MIXED_BATCH_LABELS.DONE}
          </Button>
        </div>
      )}
    </Card>
  );
}
