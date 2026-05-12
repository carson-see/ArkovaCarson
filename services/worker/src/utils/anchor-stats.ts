/**
 * Shared anchor-stats fetcher — used by both the treasury status API and
 * the treasury-cache cron.
 *
 * SCRUM-1786: reads per-status counts from `pipeline_dashboard_cache`
 * (refreshed every 2 min by `refresh_pipeline_dashboard_cache()`, which
 * uses `pg_class.reltuples` — instant, no timeout risk) instead of the
 * `get_anchor_status_counts_fast` RPC whose 1-second per-status timeouts
 * produce -1 sentinels on the 2.9M-row anchors table.
 */

import { db } from './db.js';
import { logger } from './logger.js';

export interface AnchorStats {
  total_secured: number;
  total_pending: number;
  last_secured_at: string | null;
  /** -1 sentinel = unavailable this round (24h count timed out). Caller renders "—". */
  last_24h_count: number;
}

/**
 * Fetches totals from pipeline_dashboard_cache + the most-recent-secured
 * timestamp via a bounded index scan + a 24h-window count. Returns
 * sentinel `-1` for any value that could not be measured this round.
 */
export async function fetchAnchorStats(): Promise<AnchorStats> {
  let total_secured = -1;
  let total_pending = -1;
  let last_secured_at: string | null = null;
  let last_24h_count = -1;

  try {
    const [counts, lastSeen, last24] = await Promise.allSettled([
      // SCRUM-1786: read from pipeline_dashboard_cache instead of the RPC.
      db.from('pipeline_dashboard_cache')
        .select('cache_value')
        .eq('cache_key', 'anchor_status_counts')
        .single(),
      db.from('anchors')
        .select('chain_timestamp')
        .eq('status', 'SECURED')
        .is('deleted_at', null)
        .order('chain_timestamp', { ascending: false })
        .limit(1),
      db.from('anchors')
        .select('id', { head: false })
        .is('deleted_at', null)
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .order('created_at', { ascending: false })
        .limit(1000),
    ]);

    if (counts.status === 'fulfilled' && counts.value.data && !counts.value.error) {
      const cv = (counts.value.data as { cache_value: Record<string, unknown> }).cache_value;
      total_secured = typeof cv?.SECURED === 'number' ? cv.SECURED : -1;
      total_pending = typeof cv?.PENDING === 'number' ? cv.PENDING : -1;
    } else {
      const err = counts.status === 'fulfilled' ? counts.value.error : counts.reason;
      logger.warn({ error: err }, 'fetchAnchorStats: pipeline_dashboard_cache read failed');
    }

    if (lastSeen.status === 'fulfilled' && lastSeen.value.data && lastSeen.value.data.length > 0) {
      last_secured_at = (lastSeen.value.data[0] as { chain_timestamp: string | null }).chain_timestamp ?? null;
    }

    if (last24.status === 'fulfilled' && Array.isArray(last24.value.data)) {
      last_24h_count = last24.value.data.length;
    }
  } catch (err) {
    logger.warn({ error: err }, 'fetchAnchorStats: unexpected failure, returning sentinels');
  }

  return { total_secured, total_pending, last_secured_at, last_24h_count };
}
