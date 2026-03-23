/**
 * Platform Stats Hook
 *
 * Fetches aggregate platform metrics from the admin API.
 * Only accessible to platform admins.
 */

import { useState, useCallback } from 'react';
import { workerFetch } from '@/lib/workerClient';

export interface PlatformStats {
  users: { total: number; last7Days: number };
  organizations: { total: number };
  anchors: {
    total: number;
    byStatus: Record<string, number>;
    last24h: number;
    avgSatsPerAnchor: number | null;
    totalFeeSats: number | null;
  };
  subscriptions: { byPlan: Record<string, number> };
}

export function usePlatformStats() {
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await workerFetch('/api/admin/platform-stats', { method: 'GET' });

      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: 'Request failed' }));
        setError(body.error ?? `HTTP ${response.status}`);
        setLoading(false);
        return;
      }

      const data = await response.json();
      setStats(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch platform stats');
    } finally {
      setLoading(false);
    }
  }, []);

  return { stats, loading, error, fetchStats };
}
