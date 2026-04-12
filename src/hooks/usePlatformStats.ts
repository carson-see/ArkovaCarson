/**
 * Platform Stats Hook
 *
 * Fetches aggregate platform metrics from the admin API.
 * Only accessible to platform admins.
 * Uses React Query for caching.
 */

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { workerFetch } from '@/lib/workerClient';
import { queryKeys } from '@/lib/queryClient';

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

async function fetchPlatformStatsData(): Promise<PlatformStats> {
  const response = await workerFetch('/api/admin/platform-stats', { method: 'GET' });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }

  return await response.json() as PlatformStats;
}

export function usePlatformStats() {
  const qc = useQueryClient();

  const {
    data: stats = null,
    isLoading: loading,
    error: queryError,
  } = useQuery({
    queryKey: queryKeys.platformStats(),
    queryFn: fetchPlatformStatsData,
    staleTime: 30_000,
    // Don't auto-fetch — admin page triggers manually
    enabled: false,
  });

  const fetchStats = useCallback(async () => {
    await qc.refetchQueries({ queryKey: queryKeys.platformStats() });
  }, [qc]);

  return {
    stats,
    loading,
    error: queryError ? (queryError as Error).message : null,
    fetchStats,
  };
}
