/**
 * useVersionResolution Hook (SCRUM-1126)
 *
 * Fetches pending version conflicts from the worker API and provides
 * a resolve function to pick the canonical version.
 */

import { useState, useCallback } from 'react';
import { workerFetch } from '@/lib/workerClient';

export interface VersionConflictItem {
  id: string;
  external_file_id: string | null;
  filename: string | null;
  fingerprint: string;
  created_at: string;
  sibling_count: number;
  source: string;
  status: string;
  version_number: number;
}

interface VersionApiItem {
  id: string;
  external_file_id: string | null;
  source: string;
  fingerprint: string;
  version_number: number;
  status: string;
  metadata?: { filename?: unknown } | null;
  detected_at: string;
}

function mapVersionItem(item: VersionApiItem): VersionConflictItem {
  const filename = typeof item.metadata?.filename === 'string'
    ? item.metadata.filename
    : item.external_file_id;
  return {
    id: item.id,
    external_file_id: item.external_file_id,
    filename,
    fingerprint: item.fingerprint,
    created_at: item.detected_at,
    sibling_count: 0,
    source: item.source,
    status: item.status,
    version_number: item.version_number,
  };
}

export function useVersionResolution() {
  const [items, setItems] = useState<VersionConflictItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPending = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await workerFetch('/api/v1/versions?status=pending_review', { method: 'GET' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { message?: string } | string;
        };
        const msg =
          typeof body.error === 'string'
            ? body.error
            : body.error?.message ?? `Request failed (${res.status})`;
        throw new Error(msg);
      }
      const body = (await res.json()) as { versions: VersionApiItem[] };
      setItems(Array.isArray(body.versions) ? body.versions.map(mapVersionItem) : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch pending conflicts');
    } finally {
      setLoading(false);
    }
  }, []);

  const resolve = useCallback(
    async (versionId: string, decision: 'approve' | 'skip' | 'flag' = 'approve', notes?: string) => {
      try {
        const res = await workerFetch(`/api/v1/versions/${encodeURIComponent(versionId)}/resolve`, {
          method: 'POST',
          body: JSON.stringify({
            decision,
            ...(notes ? { notes } : {}),
          }),
        });

        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: { message?: string } | string;
          };
          const msg =
            typeof body.error === 'string'
              ? body.error
              : body.error?.message ?? `Resolve failed (${res.status})`;
          throw new Error(msg);
        }

        // Remove resolved items from local state
        setItems((prev) => prev.filter((item) => item.id !== versionId));

        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to resolve conflict');
        return false;
      }
    },
    [],
  );

  return { items, loading, error, fetchPending, resolve };
}
