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

async function fetchAnchorStatsData(): Promise<AnchorStats> {
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

  // Process TX stats
  const txRaw = txStatsResult.data;
  const txData = parseRpcData(txRaw);
  const txRpcHasData = txRaw != null && !txStatsResult.error && txData.distinct_tx_count != null;
  let distinctTxIds: number;
  let avgAnchorsPerTx: number;
  let lastAnchorTime: string | null;
  let lastTxTime: string | null;

  if (txRpcHasData) {
    distinctTxIds = Number(txData.distinct_tx_count) || 0;
    const anchorsWithTx = Number(txData.anchors_with_tx) || 0;
    avgAnchorsPerTx = distinctTxIds > 0 ? Math.round(anchorsWithTx / distinctTxIds) : 0;
    lastAnchorTime = (txData.last_anchor_time as string) ?? null;
    lastTxTime = (txData.last_tx_time as string) ?? null;
  } else {
    // Fallback
    try {
      const { data: txCountData } = await dbAny.rpc('get_distinct_tx_count');
      distinctTxIds = txCountData ?? 0;
    } catch {
      const { count: txCount } = await dbAny
        .from('anchors')
        .select('chain_tx_id', { count: 'exact', head: true })
        .not('chain_tx_id', 'is', null);
      distinctTxIds = txCount ?? 0;
    }
    const { count: anchorsWithTxCount } = await dbAny
      .from('anchors')
      .select('id', { count: 'exact', head: true })
      .not('chain_tx_id', 'is', null);
    const anchorsWithTxFallback = anchorsWithTxCount ?? (statusCounts['SECURED'] ?? 0);
    avgAnchorsPerTx = distinctTxIds > 0 ? Math.round(anchorsWithTxFallback / distinctTxIds) : 0;

    const { data: lastRow } = await dbAny
      .from('anchors')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    lastAnchorTime = lastRow?.created_at ?? null;
    lastTxTime = lastAnchorTime;
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
