/**
 * useVersionResolution Hook (SCRUM-1126)
 *
 * Fetches pending version conflicts from the worker API and provides
 * a resolve function to pick the canonical version.
 */

import { useState, useCallback } from 'react';
import { workerFetch } from '@/lib/workerClient';

export interface VersionConflictItem {
  public_id: string;
  external_file_id: string | null;
  filename: string | null;
  fingerprint: string;
  created_at: string;
  sibling_count: number;
}

export function useVersionResolution() {
  const [items, setItems] = useState<VersionConflictItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPending = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await workerFetch('/api/queue/pending?limit=100', { method: 'GET' });
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
      const body = (await res.json()) as { items: VersionConflictItem[] };
      setItems(Array.isArray(body.items) ? body.items : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch pending conflicts');
    } finally {
      setLoading(false);
    }
  }, []);

  const resolve = useCallback(
    async (externalFileId: string, selectedPublicId: string, reason?: string) => {
      try {
        const res = await workerFetch('/api/queue/resolve', {
          method: 'POST',
          body: JSON.stringify({
            external_file_id: externalFileId,
            selected_public_id: selectedPublicId,
            ...(reason ? { reason } : {}),
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
        setItems((prev) =>
          prev.filter((item) => item.external_file_id !== externalFileId),
        );

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
