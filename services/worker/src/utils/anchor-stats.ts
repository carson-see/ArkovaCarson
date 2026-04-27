/**
 * Shared anchor-stats fetcher — used by both the treasury status API and
 * the treasury-cache cron. Before extraction, both files carried the same
 * 19-line Promise.all over `anchors` and SonarCloud flagged it as
 * duplicate code (CIBA-HARDEN-03 / SCRUM-1116).
 *
 * SCRUM-1259 (R1-5) rewrite: the per-status exact-count queries
 * were the customer-facing path of the same death-spiral mechanism (60s
 * PostgREST timeouts on the bloated `anchors` table). Migrated to
 * `get_anchor_status_counts_fast` RPC which uses pg_class.reltuples for
 * total + 1s per-status budget with sentinels. Last-24h is a separate,
 * time-window query — kept here with try/catch sentinel, falls back to
 * `null` when the lookup misses budget.
 */

import { db } from './db.js';
import { logger } from './logger.js';
import { callRpc } from './rpc.js';

export interface AnchorStats {
  total_secured: number;
  total_pending: number;
  last_secured_at: string | null;
  /** -1 sentinel = unavailable this round (24h count timed out). Caller renders "—". */
  last_24h_count: number;
}

interface FastCountsRpc {
  PENDING: number;
  SUBMITTED: number;
  BROADCASTING: number;
  SECURED: number;
  REVOKED: number;
  total: number;
}

/**
 * Fetches totals + the most-recent-secured timestamp via the fast RPC plus
 * a bounded 24h-window count. Returns sentinel `-1` for any value that
 * could not be measured this round; callers should render "—" rather than
 * "0" so 70%-bloat moments don't masquerade as an empty system.
 */
export async function fetchAnchorStats(): Promise<AnchorStats> {
  let total_secured = -1;
  let total_pending = -1;
  let last_secured_at: string | null = null;
  let last_24h_count = -1;

  try {
    const [counts, lastSeen, last24] = await Promise.allSettled([
      callRpc<FastCountsRpc>(db, 'get_anchor_status_counts_fast'),
      // Most-recent-secured timestamp: bounded by chain_timestamp DESC index.
      // Fast even under bloat — single-row index scan.
      db.from('anchors')
        .select('chain_timestamp')
        .eq('status', 'SECURED')
        .is('deleted_at', null)
        .order('chain_timestamp', { ascending: false })
        .limit(1),
      // Last-24h: hits idx_anchors_active_created (created_at DESC WHERE
      // deleted_at IS NULL). Index-only scan; bounded LIMIT 1 used to
      // probe responsiveness rather than full count to keep this hot path
      // sub-second under bloat. We still report a count up to the cap.
      db.from('anchors')
        .select('id', { head: false })
        .is('deleted_at', null)
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .order('created_at', { ascending: false })
        .limit(1000),
    ]);

    if (counts.status === 'fulfilled' && counts.value.data && !counts.value.error) {
      total_secured = counts.value.data.SECURED ?? -1;
      total_pending = counts.value.data.PENDING ?? -1;
    } else {
      const err = counts.status === 'fulfilled' ? counts.value.error : counts.reason;
      logger.warn({ error: err }, 'fetchAnchorStats: get_anchor_status_counts_fast failed');
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
