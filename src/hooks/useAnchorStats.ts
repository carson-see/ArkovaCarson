/**
 * useAnchorStats — Anchor aggregation stats from Supabase
 *
 * Fetches anchor counts by status, TX stats, and timing info
 * for the Treasury Dashboard.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { supabase } from '@/lib/supabase';

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

export function useAnchorStats() {
  const [stats, setStats] = useState<AnchorStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
      // Production RPC reads from stats_cache with keys like "pending_count", "secured_count"
      // Local/original RPC uses json_object_agg with keys like "PENDING", "SECURED"
      // PostgREST may return JSON as string — handle both
      const statusCounts: Record<string, number> = {};
      const statusRaw = statusResult.data;
      const statusData = parseRpcData(statusRaw);
      const rpcHasData = statusRaw != null && !statusResult.error;

      if (rpcHasData) {
        // Map from either format: cached ("pending_count") or aggregated ("PENDING")
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
        // Fallback: direct count queries (same approach as PipelineAdminPage)
        const statuses = ['PENDING', 'BROADCASTING', 'SUBMITTED', 'SECURED', 'REVOKED'];
        const countResults = await Promise.all(
          statuses.map(s =>
            dbAny.from('anchors').select('id', { count: 'exact', head: true }).eq('status', s)
          )
        );
        for (let i = 0; i < statuses.length; i++) {
          statusCounts[statuses[i]] = countResults[i].count ?? 0;
        }
      }

      const totalAnchors = Object.values(statusCounts).reduce((sum, c) => sum + c, 0);

      // Process TX stats from RPC (accurate server-side aggregation)
      // PostgREST may return the JSON object directly or wrapped — handle both
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
      } else {
        // Fallback: count distinct chain_tx_id values via RPC
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
        // Use anchors that actually have a TX, not just SECURED count
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

      if (isMountedRef.current) {
        setStats({
          byStatus: statusCounts,
          totalAnchors,
          distinctTxIds,
          avgAnchorsPerTx,
          lastAnchorTime,
          lastTxTime,
        });
        setError(null);
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to fetch anchor stats');
      }
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

  return { stats, loading, error, refresh: fetchStats };
}
