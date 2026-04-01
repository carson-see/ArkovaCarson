/**
 * useBulkAnchors Hook
 *
 * Hook for creating anchors in bulk with progress tracking.
 * Uses idempotent batch processing - safe to retry.
 */

import { useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { WORKER_URL } from '@/lib/workerClient';
import type { BulkAnchorRecord } from '@/lib/csvParser';
import { useEntitlements } from '@/hooks/useEntitlements';
import { ENTITLEMENT_LABELS, TOAST } from '@/lib/copy';

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

// Process in batches of 10 to prevent browser/server timeouts
// and provide fine-grained progress updates (SCRUM-IDT-TASK2)
const BATCH_SIZE = 10;

export function useBulkAnchors(): UseBulkAnchorsReturn {
  const { canCreateCount, remaining, loading: entitlementsLoading, refresh: refreshEntitlements } = useEntitlements();
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
      // Wait for entitlements to load before allowing creation
      if (entitlementsLoading) {
        setError('Checking plan quota — please try again');
        return null;
      }

      // Entitlement pre-check — reject early if batch exceeds remaining quota
      if (!canCreateCount(records.length)) {
        const msg = ENTITLEMENT_LABELS.BULK_EXCEEDS_QUOTA
          .replace('{remaining}', String(remaining ?? 0))
          .replace('{requested}', String(records.length));
        setError(msg);
        return null;
      }

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
            toast.error(TOAST.BULK_CANCELLED);
            return null;
          }

          const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
          const totalBatches = Math.ceil(records.length / BATCH_SIZE);
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

          // Update progress + report per-batch completion
          const processed = Math.min(i + BATCH_SIZE, records.length);
          setProcessedCount(processed);
          setProgress((processed / records.length) * 100);

          // Per-batch progress log (visible in browser console)
          console.info(
            `[BulkUpload] Batch ${batchNumber}/${totalBatches} complete — ` +
            `records ${i + 1}–${processed} of ${records.length} | ` +
            `created: ${data?.created ?? 0}, skipped: ${data?.skipped ?? 0}, failed: ${data?.failed ?? 0}`
          );
        }

        const finalResult: BulkCreateResult = {
          total: records.length,
          created: totalCreated,
          skipped: totalSkipped,
          failed: totalFailed,
          results: allResults,
        };

        // Auto-create recipient profiles for records with email addresses (BETA-04)
        const recipientRecords = records.filter(r => r.email);
        if (recipientRecords.length > 0) {
          const workerUrl = WORKER_URL;
          const { data: { session } } = await supabase.auth.getSession();
          if (session) {
            // Fetch org_id from user's profile — required by /api/recipients endpoint
            const { data: userProfile } = await supabase
              .from('profiles')
              .select('org_id')
              .eq('id', session.user.id)
              .single();
            const orgId = userProfile?.org_id;

            if (orgId) {
              // Fire-and-forget — don't block on recipient creation
              Promise.allSettled(
                recipientRecords.map(r =>
                  fetch(`${workerUrl}/api/recipients`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${session.access_token}`,
                    },
                    body: JSON.stringify({
                      email: r.email,
                      orgId,
                      fullName: r.metadata?.recipient_name ?? r.metadata?.recipient ?? r.filename.replace('.credential', ''),
                      credentialLabel: r.credentialType ?? 'Credential',
                    }),
                  }).catch(() => { /* non-fatal */ })
                )
              );
            }
          }
        }

        // Refresh entitlement counts after successful bulk creation
        await refreshEntitlements();

        if (totalFailed > 0) {
          toast.warning(
            TOAST.BULK_PARTIAL
              .replace('{created}', String(totalCreated))
              .replace('{failed}', String(totalFailed))
          );
        } else {
          toast.success(
            TOAST.BULK_COMPLETE.replace('{created}', String(totalCreated))
          );
        }

        return finalResult;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'An unexpected error occurred';
        setError(message);
        toast.error(TOAST.BULK_FAILED);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [canCreateCount, remaining, entitlementsLoading, refreshEntitlements]
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
