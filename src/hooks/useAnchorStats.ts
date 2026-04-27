/**
 * useAnchorStats — Anchor aggregation stats from Supabase
 *
 * Fetches anchor counts by status, TX stats, and timing info
 * for the Treasury Dashboard. Uses React Query for caching.
 */

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/queryClient';

/** Parse RPC data that PostgREST may return as a JSON string or object */
function parseRpcData(data: unknown): Record<string, unknown> {
  if (data == null) return {};
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch { return {}; }
  }
  return data as Record<string, unknown>;
}

export interface AnchorStats {
  byStatus: Record<string, number>;
  totalAnchors: number;
  distinctTxIds: number;
  avgAnchorsPerTx: number;
  lastAnchorTime: string | null;
  lastTxTime: string | null;
}

export async function fetchAnchorStatsData(): Promise<AnchorStats> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = supabase as any;

  // Try SECURITY DEFINER RPCs first for accurate counts
  const [statusResult, txStatsResult] = await Promise.all([
    dbAny.rpc('get_anchor_status_counts'),
    dbAny.rpc('get_anchor_tx_stats'),
  ]);

  // Process status counts
  const statusCounts: Record<string, number> = {};
  const statusRaw = statusResult.data;
  const statusData = parseRpcData(statusRaw);
  const rpcHasData = statusRaw != null && !statusResult.error;

  if (rpcHasData) {
    const statusMap: Record<string, string> = {
      PENDING: 'pending_count',
      BROADCASTING: 'broadcasting_count',
      SUBMITTED: 'submitted_count',
      SECURED: 'secured_count',
      REVOKED: 'revoked_count',
    };
    for (const [status, cacheKey] of Object.entries(statusMap)) {
      statusCounts[status] = Number(statusData[status] ?? statusData[cacheKey]) || 0;
    }
  } else {
    // SCRUM-1260 (R1-6): the previous fallback fanned out 5 exact-count queries
    // against the bloated 1.4M-row `anchors` table — each was a 60s PostgREST
    // timeout candidate. Drop the fallback and surface the error so React
    // Query's `error` slot lights up; the consuming hook converts that to
    // a banner instead of rendering 0/0/0 indistinguishable from "empty system."
    throw new Error(
      `get_anchor_status_counts RPC unavailable${statusResult.error ? `: ${(statusResult.error as { message?: string }).message ?? 'unknown error'}` : ''}`,
    );
  }

  const totalAnchors = Object.values(statusCounts).reduce((sum, c) => sum + c, 0);

  // Process TX stats. `get_anchor_tx_stats` is restricted to service_role per
  // migration 0269 (SEC-RECON-7). Non-platform-admin users predictably see 403
  // (`42501 permission denied for function`) — that's expected, not a fault.
  // The previous fallback ran a `count: 'exact'` against the bloated anchors
  // table (R1-1 vacuum still finishing), reliably timing out at 30s. Drop the
  // fallback: a missing tx-stats panel is better than a 30s page hang.
  const txRaw = txStatsResult.data;
  const txData = parseRpcData(txRaw);
  const txRpcHasData = txRaw != null && !txStatsResult.error && txData.distinct_tx_count != null;
  let distinctTxIds = 0;
  let avgAnchorsPerTx = 0;
  let lastAnchorTime: string | null = null;
  let lastTxTime: string | null = null;

  if (txRpcHasData) {
    distinctTxIds = Number(txData.distinct_tx_count) || 0;
    const anchorsWithTx = Number(txData.anchors_with_tx) || 0;
    avgAnchorsPerTx = distinctTxIds > 0 ? Math.round(anchorsWithTx / distinctTxIds) : 0;
    lastAnchorTime = (txData.last_anchor_time as string) ?? null;
    lastTxTime = (txData.last_tx_time as string) ?? null;
  }

  return {
    byStatus: statusCounts,
    totalAnchors,
    distinctTxIds,
    avgAnchorsPerTx,
    lastAnchorTime,
    lastTxTime,
  };
}

export function useAnchorStats() {
  const qc = useQueryClient();

  const {
    data: stats = null,
    isLoading: loading,
    error: queryError,
  } = useQuery({
    queryKey: queryKeys.anchorStats(),
    queryFn: fetchAnchorStatsData,
    staleTime: 30_000, // Stats refresh every 30s
  });

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: queryKeys.anchorStats() });
  }, [qc]);

  return {
    stats,
    loading,
    error: queryError ? (queryError as Error).message : null,
    refresh,
  };
}
