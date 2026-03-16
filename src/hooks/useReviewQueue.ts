/**
 * useReviewQueue Hook (P8-S9)
 *
 * Fetches review queue items and stats, applies review actions.
 */

import { useState, useCallback } from 'react';
import { workerFetch } from '@/lib/workerClient';

export type ReviewStatus = 'PENDING' | 'APPROVED' | 'INVESTIGATING' | 'ESCALATED' | 'DISMISSED';
export type ReviewAction = 'APPROVE' | 'INVESTIGATE' | 'ESCALATE' | 'DISMISS';

export interface ReviewQueueItem {
  id: string;
  anchorId: string;
  orgId: string;
  status: ReviewStatus;
  priority: number;
  reason: string;
  flags: string[];
  assignedTo: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  reviewAction: ReviewAction | null;
  createdAt: string;
  updatedAt: string;
  anchorTitle?: string;
  anchorFingerprint?: string;
  anchorCredentialType?: string;
  integrityScore?: number;
  integrityLevel?: string;
}

export interface ReviewQueueStats {
  total: number;
  pending: number;
  investigating: number;
  escalated: number;
  approved: number;
  dismissed: number;
}

export function useReviewQueue() {
  const [items, setItems] = useState<ReviewQueueItem[]>([]);
  const [stats, setStats] = useState<ReviewQueueStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);

  const fetchItems = useCallback(async (status?: ReviewStatus) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      params.set('limit', '50');

      const res = await workerFetch(`/api/v1/ai/review?${params}`);
      if (!res.ok) return;

      const data = await res.json() as { items: ReviewQueueItem[] };
      setItems(data.items);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const res = await workerFetch('/api/v1/ai/review/stats');
      if (!res.ok) return;

      const data = await res.json() as ReviewQueueStats;
      setStats(data);
    } catch {
      // Non-fatal
    }
  }, []);

  const applyAction = useCallback(async (
    itemId: string,
    action: ReviewAction,
    notes?: string,
  ) => {
    setActing(true);
    try {
      const res = await workerFetch(`/api/v1/ai/review/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify({ action, notes }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as Record<string, string>).error ?? 'Failed to apply action');
      }

      // Update local state
      setItems((prev) =>
        prev.map((item) =>
          item.id === itemId
            ? { ...item, status: actionToStatus(action), reviewAction: action }
            : item,
        ),
      );

      return true;
    } finally {
      setActing(false);
    }
  }, []);

  return { items, stats, loading, acting, fetchItems, fetchStats, applyAction };
}

function actionToStatus(action: ReviewAction): ReviewStatus {
  const map: Record<ReviewAction, ReviewStatus> = {
    APPROVE: 'APPROVED',
    INVESTIGATE: 'INVESTIGATING',
    ESCALATE: 'ESCALATED',
    DISMISS: 'DISMISSED',
  };
  return map[action];
}
