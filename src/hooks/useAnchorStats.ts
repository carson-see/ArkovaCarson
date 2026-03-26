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
      // Fetch counts by status
      const statusCounts: Record<string, number> = {};
      const statuses = ['PENDING', 'BROADCASTING', 'SUBMITTED', 'SECURED', 'REVOKED'] as const;

      const countPromises = statuses.map(async (status) => {
        const { count } = await supabase
          .from('anchors')
          .select('*', { count: 'exact', head: true })
          .eq('status', status)
          .is('deleted_at', null);
        return { status, count: count ?? 0 };
      });

      // Fetch distinct tx_ids count and last times
      const [countsResult, txStatsResult, lastAnchorResult] = await Promise.all([
        Promise.all(countPromises),
        supabase
          .from('anchors')
          .select('chain_tx_id')
          .not('chain_tx_id', 'is', null)
          .is('deleted_at', null),
        supabase
          .from('anchors')
          .select('created_at, chain_tx_id')
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      if (!isMountedRef.current) return;

      // Process status counts
      for (const { status, count } of countsResult) {
        statusCounts[status] = count;
      }
      const totalAnchors = Object.values(statusCounts).reduce((sum, c) => sum + c, 0);

      // Process distinct tx_ids
      const txIds = new Set<string>();
      if (txStatsResult.data) {
        for (const row of txStatsResult.data) {
          if (row.chain_tx_id) txIds.add(row.chain_tx_id);
        }
      }
      const distinctTxIds = txIds.size;
      const anchorsWithTx = txStatsResult.data?.length ?? 0;
      const avgAnchorsPerTx = distinctTxIds > 0 ? Math.round(anchorsWithTx / distinctTxIds) : 0;

      // Last anchor time
      const lastAnchorTime = lastAnchorResult.data?.created_at ?? null;

      // Last TX time (most recent anchor with a tx_id)
      const { data: lastTxData } = await supabase
        .from('anchors')
        .select('updated_at')
        .not('chain_tx_id', 'is', null)
        .is('deleted_at', null)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (isMountedRef.current) {
        setStats({
          byStatus: statusCounts,
          totalAnchors,
          distinctTxIds,
          avgAnchorsPerTx,
          lastAnchorTime,
          lastTxTime: lastTxData?.updated_at ?? null,
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
