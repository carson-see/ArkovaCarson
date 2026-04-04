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

      // Try SECURITY DEFINER RPCs first for accurate counts
      const [statusResult, txStatsResult] = await Promise.all([
        dbAny.rpc('get_anchor_status_counts'),
        dbAny.rpc('get_anchor_tx_stats'),
      ]);

      if (!isMountedRef.current) return;

      // Process status counts — RPC returns object or null
      const statusCounts: Record<string, number> = {};
      const statusData = statusResult.data ?? {};
      const rpcHasData = statusResult.data && !statusResult.error;

      if (rpcHasData) {
        for (const status of ['PENDING', 'BROADCASTING', 'SUBMITTED', 'SECURED', 'REVOKED']) {
          statusCounts[status] = statusData[status] ?? 0;
        }
      } else {
        // Fallback: direct count queries (same approach as PipelineAdminPage)
        const statuses = ['PENDING', 'BROADCASTING', 'SUBMITTED', 'SECURED', 'REVOKED'];
        const countResults = await Promise.all(
          statuses.map(s =>
            dbAny.from('anchors').select('*', { count: 'exact', head: true }).eq('status', s)
          )
        );
        for (let i = 0; i < statuses.length; i++) {
          statusCounts[statuses[i]] = countResults[i].count ?? 0;
        }
      }

      const totalAnchors = Object.values(statusCounts).reduce((sum, c) => sum + c, 0);

      // Process TX stats from RPC (accurate server-side aggregation)
      const txData = txStatsResult.data ?? {};
      const txRpcHasData = txStatsResult.data && !txStatsResult.error;
      let distinctTxIds = 0;
      let avgAnchorsPerTx = 0;
      let lastAnchorTime: string | null = null;
      let lastTxTime: string | null = null;

      if (txRpcHasData) {
        distinctTxIds = txData.distinct_tx_count ?? 0;
        const anchorsWithTx = txData.anchors_with_tx ?? 0;
        avgAnchorsPerTx = distinctTxIds > 0 ? Math.round(anchorsWithTx / distinctTxIds) : 0;
        lastAnchorTime = txData.last_anchor_time ?? null;
        lastTxTime = txData.last_tx_time ?? null;
      } else {
        // Fallback: count distinct chain_tx_id values via RPC
        // Supabase JS .select() with count counts rows, not distinct values,
        // so we use a raw SQL query for accuracy
        try {
          const { data: txCountData } = await dbAny.rpc('get_distinct_tx_count');
          distinctTxIds = txCountData ?? 0;
        } catch {
          // Final fallback: count anchors with chain_tx_id (overcounts but better than 0)
          const { count: txCount } = await dbAny
            .from('anchors')
            .select('chain_tx_id', { count: 'exact', head: true })
            .not('chain_tx_id', 'is', null);
          distinctTxIds = txCount ?? 0;
        }
        const anchorsWithTxFallback = statusCounts['SECURED'] ?? 0;
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
