/**
 * useBulkAnchors Hook
 *
 * Hook for creating anchors in bulk with progress tracking.
 * Uses idempotent batch processing - safe to retry.
 */

import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import type { BulkAnchorRecord } from '@/lib/csvParser';

interface BulkAnchorResult {
  fingerprint: string;
  status: 'created' | 'skipped' | 'failed';
  id?: string;
  reason?: string;
  existingId?: string;
}

interface BulkCreateResult {
  total: number;
  created: number;
  skipped: number;
  failed: number;
  results: BulkAnchorResult[];
}

interface UseBulkAnchorsReturn {
  createBulkAnchors: (records: BulkAnchorRecord[]) => Promise<BulkCreateResult | null>;
  loading: boolean;
  progress: number;
  processedCount: number;
  totalCount: number;
  error: string | null;
  clearError: () => void;
  cancel: () => void;
}

// Process in batches to show progress
const BATCH_SIZE = 50;

export function useBulkAnchors(): UseBulkAnchorsReturn {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [processedCount, setProcessedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
  }, []);

  const createBulkAnchors = useCallback(
    async (records: BulkAnchorRecord[]): Promise<BulkCreateResult | null> => {
      setLoading(true);
      setError(null);
      setProgress(0);
      setProcessedCount(0);
      setTotalCount(records.length);
      cancelledRef.current = false;

      try {
        const allResults: BulkAnchorResult[] = [];
        let totalCreated = 0;
        let totalSkipped = 0;
        let totalFailed = 0;

        // Process in batches for progress tracking
        for (let i = 0; i < records.length; i += BATCH_SIZE) {
          if (cancelledRef.current) {
            setError('Operation cancelled');
            return null;
          }

          const batch = records.slice(i, i + BATCH_SIZE);
          const batchData = batch.map(r => ({
            fingerprint: r.fingerprint,
            filename: r.filename,
            fileSize: r.fileSize || null,
            credentialType: r.credentialType || null,
            metadata: r.metadata || null,
          }));

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data, error: rpcError } = await (supabase.rpc as any)(
            'bulk_create_anchors',
            { anchors_data: batchData }
          );

          if (rpcError) {
            throw new Error(rpcError.message || 'Failed to process batch');
          }

          if (data) {
            totalCreated += data.created || 0;
            totalSkipped += data.skipped || 0;
            totalFailed += data.failed || 0;

            if (data.results) {
              allResults.push(...data.results);
            }
          }

          // Update progress
          const processed = Math.min(i + BATCH_SIZE, records.length);
          setProcessedCount(processed);
          setProgress((processed / records.length) * 100);
        }

        const finalResult: BulkCreateResult = {
          total: records.length,
          created: totalCreated,
          skipped: totalSkipped,
          failed: totalFailed,
          results: allResults,
        };

        return finalResult;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'An unexpected error occurred';
        setError(message);
        return null;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  return {
    createBulkAnchors,
    loading,
    progress,
    processedCount,
    totalCount,
    error,
    clearError,
    cancel,
  };
}
