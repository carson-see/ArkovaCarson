/**
 * useAnchorStats — Anchor aggregation stats from Supabase
 *
 * Fetches anchor counts by status, TX stats, and timing info
 * for the Treasury Dashboard.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { supabase } from '@/lib/supabase';

export interface AnchorStats {
  byStatus: Record<string, number>;
  totalAnchors: number;
  distinctTxIds: number;
  avgAnchorsPerTx: number;
  lastAnchorTime: string | null;
  lastTxTime: string | null;
}

export function useAnchorStats() {
  const [stats, setStats] = useState<AnchorStats | null>(null);
  const [loading, setLoading] = useState(true);
  const isMountedRef = useRef(true);

  const fetchStats = useCallback(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dbAny = supabase as any;

      // Use SECURITY DEFINER RPCs for accurate counts (bypasses RLS row limits)
      const [statusResult, txStatsResult] = await Promise.all([
        dbAny.rpc('get_anchor_status_counts'),
        dbAny.rpc('get_anchor_tx_stats'),
      ]);

      if (!isMountedRef.current) return;

      // Process status counts from RPC
      const statusCounts: Record<string, number> = {};
      const statusData = statusResult.data ?? {};
      for (const status of ['PENDING', 'BROADCASTING', 'SUBMITTED', 'SECURED', 'REVOKED']) {
        statusCounts[status] = statusData[status] ?? 0;
      }
      const totalAnchors = Object.values(statusCounts).reduce((sum, c) => sum + c, 0);

      // Process TX stats from RPC (accurate server-side aggregation)
      const txData = txStatsResult.data ?? {};
      const distinctTxIds = txData.distinct_tx_count ?? 0;
      const anchorsWithTx = txData.anchors_with_tx ?? 0;
      const avgAnchorsPerTx = distinctTxIds > 0 ? Math.round(anchorsWithTx / distinctTxIds) : 0;
      const lastAnchorTime = txData.last_anchor_time ?? null;
      const lastTxTime = txData.last_tx_time ?? null;

      if (isMountedRef.current) {
        setStats({
          byStatus: statusCounts,
          totalAnchors,
          distinctTxIds,
          avgAnchorsPerTx,
          lastAnchorTime,
          lastTxTime,
        });
      }
    } catch {
      // Stats fetch failed — leave null
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    void fetchStats();
    return () => { isMountedRef.current = false; };
  }, [fetchStats]);

  return { stats, loading, refresh: fetchStats };
}
