/**
 * useBulkAnchors Hook
 *
 * Hook for creating anchors in bulk with progress tracking.
 * Uses idempotent batch processing - safe to retry.
 */

import { useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { workerFetch } from '@/lib/workerClient';
import type { SecuringPath } from '@/lib/queueContract';
import type { BulkAnchorRecord } from '@/lib/csvParser';
import { useEntitlements } from '@/hooks/useEntitlements';
import { BULK_IMPORT_LABELS, ENTITLEMENT_LABELS, TOAST, RECORD_ATTESTATION_LABELS } from '@/lib/copy';

/** R19: options for createBulkAnchors. `attested` must be true whenever the
 * batch contains any record-derived (fingerprintProvided === false) rows —
 * the issuer-attestation acknowledgement gate (BulkUploadWizard ReviewStep). */
export interface CreateBulkAnchorsOptions {
  attested?: boolean;
  action?: SecuringPath;
  description?: string;
  privateTags?: { user: string[]; organization: string[] };
}

/** `*_recipient_failed` means the anchor committed and only the recipient
 *  link failed — the row must never be re-submitted (SCRUM-5265). */
export type BulkAnchorResultStatus =
  'created' | 'skipped' | 'failed' | 'created_recipient_failed' | 'skipped_recipient_failed';

interface BulkAnchorResult {
  fingerprint: string;
  status: BulkAnchorResultStatus;
  id?: string;
  reason?: string;
  existingId?: string;
  instant_status?: 'QUEUED' | 'PROCESSING' | 'NEEDS_CREDIT' | 'RETRYABLE' | 'HELD' | 'SUBMITTED' | 'FAILED' | null;
}

interface BulkCreateResult {
  total: number;
  created: number;
  skipped: number;
  failed: number;
  /** Additive: also counted in `created`/`skipped`, never in `failed`. */
  recipient_link_failed?: number;
  results: BulkAnchorResult[];
  partial?: boolean;
}

interface UseBulkAnchorsReturn {
  createBulkAnchors: (records: BulkAnchorRecord[], options?: CreateBulkAnchorsOptions) => Promise<BulkCreateResult | null>;
  loading: boolean;
  progress: number;
  processedCount: number;
  totalCount: number;
  error: string | null;
  clearError: () => void;
  cancel: () => void;
}

interface UseBulkAnchorsOptions {
  orgId?: string | null;
}

// Process in batches of 10 to prevent browser/server timeouts
// and provide fine-grained progress updates (SCRUM-IDT-TASK2)
const BATCH_SIZE = 10;

/**
 * The recipient half of a bulk row, or nothing.
 *
 * B1 (#3034 review): recipient provisioning is an ORGANIZATION capability —
 * personal scope can never be granted it. `main` reflected that by skipping the
 * recipient pass whenever it could not resolve an org; this restores it at the
 * request boundary. Sending a recipient from personal scope would ask the worker
 * for something it must refuse, so every row would come back
 * `*_recipient_failed` for a reason the user cannot act on — and a CSV column
 * merely CONTAINING "mail" is auto-mapped to `email` by `csvParser`, so this is
 * the common case, not the exotic one.
 *
 * A plain org MEMBER also cannot provision, but the hook has no role
 * information — only the selected org id — so that case is left to the server,
 * which now anchors the rows and reports the refusal per row rather than
 * rejecting the batch.
 *
 * `recipient_name` is emitted only alongside an email: the worker's schema
 * rejects the name-without-email pair for the WHOLE request.
 */
function recipientFields(
  record: BulkAnchorRecord,
  orgId: string | null,
): { recipient_email?: string; recipient_name?: string } {
  if (!orgId || !record.email) return {};
  const name = typeof record.metadata?.recipient_name === 'string' ? record.metadata.recipient_name : undefined;
  return { recipient_email: record.email, ...(name === undefined ? {} : { recipient_name: name }) };
}

export function useBulkAnchors(options: UseBulkAnchorsOptions = {}): UseBulkAnchorsReturn {
  const targetOrgId = options.orgId ?? null;
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
    async (records: BulkAnchorRecord[], options: CreateBulkAnchorsOptions = {}): Promise<BulkCreateResult | null> => {
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

      // R19 (CTO ruling 2026-07-28): any record whose fingerprint was
      // synthesized from row text (fingerprintProvided === false) requires
      // the issuer-attestation acknowledgement before the batch may proceed.
      // Client-side gate mirrors the canonical worker's record-class
      // computation. It does not replace server enforcement; it prevents an
      // unacknowledged submission from reaching the bulk HTTP boundary.
      const requiresAttestation = records.some(r => r.fingerprintProvided === false);
      if (requiresAttestation && !options.attested) {
        setError(RECORD_ATTESTATION_LABELS.ACKNOWLEDGEMENT_REQUIRED_ERROR);
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
        let totalRecipientLinkFailed = 0;

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
          const response = await workerFetch('/api/v1/anchor-self-service/bulk', {
              method: 'POST',
              body: JSON.stringify({
                org_id: targetOrgId,
                action: options.action ?? 'queue',
                description: options.description?.trim() || undefined,
                private_tags: options.privateTags ?? { user: [], organization: [] },
                rows: batch.map((record) => ({
                  fingerprint: record.fingerprint,
                  filename: record.filename,
                  file_size: record.fileSize,
                  credential_type: record.credentialType,
                  metadata: record.metadata,
                  fingerprint_provided: record.fingerprintProvided ?? false,
                  ...recipientFields(record, targetOrgId),
                })),
              }),
            });
          const data = await response.json().catch(() => null) as BulkCreateResult | null;
          const hasStructuredResults = Boolean(data && Array.isArray(data.results));
          if (!response.ok && !hasStructuredResults) throw new Error('Failed to process batch');

          if (data) {
            totalCreated += data.created || 0;
            totalSkipped += data.skipped || 0;
            totalFailed += data.failed || 0;
            totalRecipientLinkFailed += data.recipient_link_failed || 0;

            if (data.results) {
              allResults.push(...data.results);
            }
          }

          if (!response.ok) {
            const partialResult: BulkCreateResult = {
              total: allResults.length,
              created: totalCreated,
              skipped: totalSkipped,
              failed: totalFailed,
              recipient_link_failed: totalRecipientLinkFailed,
              results: allResults,
              partial: true,
            };
            setError(BULK_IMPORT_LABELS.PARTIAL_TRANSPORT);
            toast.warning(BULK_IMPORT_LABELS.PARTIAL_TRANSPORT);
            await refreshEntitlements();
            return partialResult;
          }

          // Update progress + report per-batch completion
          const processed = Math.min(i + BATCH_SIZE, records.length);
          setProcessedCount(processed);
          setProgress((processed / records.length) * 100);

          // Per-batch progress log (visible in browser console)
          console.info(
            `[BulkUpload] Batch ${batchNumber}/${totalBatches} complete — ` +
            `records ${i + 1}–${processed} of ${records.length} | ` +
            `created: ${data?.created ?? 0}, skipped: ${data?.skipped ?? 0}, failed: ${data?.failed ?? 0}, ` +
            `recipient link failed: ${data?.recipient_link_failed ?? 0}`
          );
        }

        const finalResult: BulkCreateResult = {
          total: records.length,
          created: totalCreated,
          skipped: totalSkipped,
          failed: totalFailed,
          recipient_link_failed: totalRecipientLinkFailed,
          results: allResults,
        };

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
    [canCreateCount, remaining, entitlementsLoading, refreshEntitlements, targetOrgId]
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
