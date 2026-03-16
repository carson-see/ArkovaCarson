/**
 * useExtractionFeedback Hook (P8-S6)
 *
 * Sends extraction feedback (accept/reject/edit) to the worker API
 * and fetches accuracy statistics.
 */

import { useState, useCallback } from 'react';
import { workerFetch } from '@/lib/workerClient';

export interface FeedbackItem {
  anchorId: string;
  fingerprint: string;
  credentialType: string;
  fieldKey: string;
  originalValue?: string | null;
  correctedValue?: string | null;
  action: 'accepted' | 'rejected' | 'edited';
  originalConfidence?: number;
  provider?: string;
}

export interface AccuracyStat {
  credentialType: string;
  fieldKey: string;
  totalSuggestions: number;
  acceptedCount: number;
  rejectedCount: number;
  editedCount: number;
  acceptanceRate: number;
  avgConfidence: number;
}

export function useExtractionFeedback() {
  const [submitting, setSubmitting] = useState(false);
  const [accuracyStats, setAccuracyStats] = useState<AccuracyStat[]>([]);
  const [loadingStats, setLoadingStats] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitFeedback = useCallback(async (items: FeedbackItem[]) => {
    setSubmitting(true);
    try {
      const res = await workerFetch('/api/v1/ai/feedback', {
        method: 'POST',
        body: JSON.stringify({ items }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as Record<string, string>).error ?? 'Failed to submit feedback');
      }

      return await res.json() as { stored: number; errors: number; total: number };
    } finally {
      setSubmitting(false);
    }
  }, []);

  const fetchAccuracy = useCallback(async (credentialType?: string, days?: number) => {
    setLoadingStats(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (credentialType) params.set('credentialType', credentialType);
      if (days) params.set('days', String(days));

      const res = await workerFetch(`/api/v1/ai/feedback/accuracy?${params}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError((err as Record<string, string>).error ?? 'Failed to fetch accuracy');
        setAccuracyStats([]);
        return;
      }

      const data = await res.json() as { stats: AccuracyStat[] };
      setAccuracyStats(data.stats);
    } catch {
      setError('Failed to fetch accuracy');
      setAccuracyStats([]);
    } finally {
      setLoadingStats(false);
    }
  }, []);

  return { submitFeedback, submitting, fetchAccuracy, accuracyStats, loadingStats, error };
}
