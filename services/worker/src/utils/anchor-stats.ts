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
  total_broadcasting: number;
  total_submitted: number;
  total_revoked: number;
  by_status: Record<string, number>;
  last_secured_at: string | null;
  /** -1 sentinel = unavailable or approximate-only this round. Caller renders "—". */
  distinct_tx_count: number;
  /** -1 sentinel = unavailable this round. */
  anchors_with_tx: number;
  /** -1 sentinel = unavailable or distinct tx count is approximate-only this round. */
  avg_anchors_per_tx: number;
  last_anchor_time: string | null;
  last_tx_time: string | null;
  distinct_tx_approximate: boolean;
  /** -1 sentinel = unavailable this round (24h count timed out). Caller renders "—". */
  last_24h_count: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse RPC data that PostgREST may return as a JSON string or object. */
function parseRpcData(data: unknown): Record<string, unknown> {
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(data) ? data : {};
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Fetches totals from pipeline_dashboard_cache + the most-recent-secured
 * timestamp via a bounded index scan + a 24h-window count. Returns
 * sentinel `-1` for any value that could not be measured this round.
 */
export async function fetchAnchorStats(): Promise<AnchorStats> {
  let total_secured = -1;
  let total_pending = -1;
  let total_broadcasting = -1;
  let total_submitted = -1;
  let total_revoked = -1;
  let last_secured_at: string | null = null;
  let last_24h_count = -1;
  let distinct_tx_count = -1;
  let anchors_with_tx = -1;
  let avg_anchors_per_tx = -1;
  let last_anchor_time: string | null = null;
  let last_tx_time: string | null = null;
  let distinct_tx_approximate = false;
  let by_status: Record<string, number> = {};

  try {
    const [counts, lastSeen, last24, txStats] = await Promise.allSettled([
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
      db.rpc('get_anchor_tx_stats'),
    ]);

    if (counts.status === 'fulfilled' && counts.value.data && !counts.value.error) {
      const cv = (counts.value.data as { cache_value: Record<string, unknown> }).cache_value;
      total_secured = typeof cv?.SECURED === 'number' ? cv.SECURED : -1;
      total_pending = typeof cv?.PENDING === 'number' ? cv.PENDING : -1;
      total_broadcasting = typeof cv?.BROADCASTING === 'number' ? cv.BROADCASTING : -1;
      total_submitted = typeof cv?.SUBMITTED === 'number' ? cv.SUBMITTED : -1;
      total_revoked = typeof cv?.REVOKED === 'number' ? cv.REVOKED : -1;
      by_status = {
        PENDING: Math.max(total_pending, 0),
        BROADCASTING: Math.max(total_broadcasting, 0),
        SUBMITTED: Math.max(total_submitted, 0),
        SECURED: Math.max(total_secured, 0),
        REVOKED: Math.max(total_revoked, 0),
      };
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

    if (txStats.status === 'fulfilled' && txStats.value.data && !txStats.value.error) {
      const txData = parseRpcData(txStats.value.data);
      const cacheMiss = txData.cache_miss === true;
      distinct_tx_approximate = txData.distinct_tx_approximate === true;

      const distinct = toFiniteNumber(txData.distinct_tx_count);
      const withTx = toFiniteNumber(txData.anchors_with_tx);
      anchors_with_tx = cacheMiss || withTx === null || withTx < 0 ? -1 : withTx;
      if (!cacheMiss && !distinct_tx_approximate && distinct !== null && distinct >= 0) {
        distinct_tx_count = distinct;
        if (distinct === 0) {
          avg_anchors_per_tx = 0;
        } else if (anchors_with_tx >= 0) {
          avg_anchors_per_tx = Math.round(anchors_with_tx / distinct);
        }
      }
      last_anchor_time = toNullableString(txData.last_anchor_time);
      last_tx_time = toNullableString(txData.last_tx_time);
    } else {
      const err = txStats.status === 'fulfilled' ? txStats.value.error : txStats.reason;
      logger.warn({ error: err }, 'fetchAnchorStats: get_anchor_tx_stats read failed');
    }
  } catch (err) {
    logger.warn({ error: err }, 'fetchAnchorStats: unexpected failure, returning sentinels');
  }

  return {
    total_secured,
    total_pending,
    total_broadcasting,
    total_submitted,
    total_revoked,
    by_status,
    last_secured_at,
    distinct_tx_count,
    anchors_with_tx,
    avg_anchors_per_tx,
    last_anchor_time,
    last_tx_time,
    distinct_tx_approximate,
    last_24h_count,
  };
}
