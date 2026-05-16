/**
 * useVersionResolution Hook (SCRUM-1972 / SCRUM-1126)
 *
 * Fetches pending version conflicts and resolves them via worker API.
 */

import { useState, useCallback } from 'react';
import { workerFetch } from '@/lib/workerClient';

export type VersionStatus = 'pending_review' | 'approved' | 'skipped' | 'flagged';
export type ResolutionDecision = 'approve' | 'skip' | 'flag';

export interface VersionConflictItem {
  id: string;
  org_id: string;
  external_file_id: string;
  filename: string | null;
  fingerprint: string;
  source: string;
  status: VersionStatus;
  version_number: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface ResolveResult {
  success: boolean;
  decision: ResolutionDecision;
  version_id: string;
  status: string;
}

export function useVersionResolution() {
  const [items, setItems] = useState<VersionConflictItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPending = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await workerFetch('/api/v1/versions?status=pending_review');
      if (!res.ok) {
        setError('Failed to load version conflicts');
        return;
      }
      const data = await res.json() as { versions: VersionConflictItem[] };
      setItems(data.versions);
    } catch {
      setError('Failed to load version conflicts');
    } finally {
      setLoading(false);
    }
  }, []);

  const resolve = useCallback(async (
    versionId: string,
    decision: ResolutionDecision,
    notes?: string,
  ): Promise<ResolveResult | null> => {
    setError(null);
    try {
      const res = await workerFetch(`/api/v1/versions/${versionId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, ...(notes ? { notes } : {}) }),
      });
      if (!res.ok) {
        setError('Resolution failed');
        return null;
      }
      return await res.json() as ResolveResult;
    } catch {
      setError('Resolution failed');
      return null;
    }
  }, []);

  return { items, loading, error, fetchPending, resolve };
}
