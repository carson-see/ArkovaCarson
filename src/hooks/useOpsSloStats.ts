/**
 * useOpsSloStats Hook (SCRUM-2401 / OPS-03)
 *
 * Fetches the platform SLO dashboard rollup from the worker's
 * GET /api/admin/ops-slo-stats endpoint. Platform-admin gated server-side;
 * non-admins get a 403 surfaced as `error`.
 *
 * Mirrors useSystemHealth.ts's shape (loading/error/data + explicit refetch)
 * so OpsSloDashboardPage can reuse the same polling pattern as
 * SystemHealthPage / PipelineAdminPage (useVisibilityPolling).
 */

import { useState, useCallback } from 'react';
import { workerFetch } from '@/lib/workerClient';
import type { OpsSloStats } from '@/types/opsSlo';

// The response-surface interfaces are a hand-maintained mirror of the worker's
// contract; they live in a types-only module (@/types/opsSlo) so the
// unavoidable cross-build-root duplication is isolated. Re-exported here so
// existing consumers keep importing them from `@/hooks/useOpsSloStats`.
export type {
  AnchorSecuredRateSurface,
  ConnectorQueueSurface,
  CreditConservationSurface,
  WebhookDeliverySurface,
  ApiErrorsSurface,
  OpsSloStats,
} from '@/types/opsSlo';

interface UseOpsSloStatsReturn {
  stats: OpsSloStats | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * `loading` starts true, but this hook does NOT self-fetch on mount — the
 * consuming page owns when the first fetch fires (matches `useSystemHealth`'s
 * `fetchHealth` contract exactly). Typically driven by `useVisibilityPolling`,
 * which already calls back once on mount; a second "fetch on mount" trigger
 * here would double-fetch every page load.
 */
export function useOpsSloStats(): UseOpsSloStatsReturn {
  const [stats, setStats] = useState<OpsSloStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    try {
      const response = await workerFetch('/api/admin/ops-slo-stats', { method: 'GET' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: 'Request failed' }));
        setError(body.error ?? `HTTP ${response.status}`);
        setStats(null);
        return;
      }
      const data = (await response.json()) as OpsSloStats;
      setStats(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch SLO stats');
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, []);

  return { stats, loading, error, refetch: fetchStats };
}
