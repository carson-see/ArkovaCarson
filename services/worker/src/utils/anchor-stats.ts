/**
 * Shared anchor-stats fetcher — used by both the treasury status API and
 * the treasury-cache cron. Before extraction, both files carried the same
 * 19-line Promise.all over `anchors` and SonarCloud flagged it as
 * duplicate code (CIBA-HARDEN-03 / SCRUM-1116).
 *
 * Keeping the query in one place also means any future index tune (BRIN
 * on `anchors(created_at)`, partial indexes on `status='SECURED'`, etc.)
 * only needs one change to benefit both callsites.
 */

import { db } from './db.js';
import { logger } from './logger.js';

export interface AnchorStats {
  total_secured: number;
  total_pending: number;
  last_secured_at: string | null;
  last_24h_count: number;
}

/**
 * Fetches totals + the most-recent-secured timestamp in a single
 * Promise.all round-trip. Returns zero-valued defaults on any Supabase
 * error — both callers want best-effort stats, not a hard fail.
 */
export async function fetchAnchorStats(): Promise<AnchorStats> {
  try {
    const [
      { count: securedCount },
      { count: pendingCount },
      { data: lastSecured },
      { count: last24hCount },
    ] = await Promise.all([
      db.from('anchors').select('*', { count: 'exact', head: true })
        .eq('status', 'SECURED').is('deleted_at', null),
      db.from('anchors').select('*', { count: 'exact', head: true })
        .eq('status', 'PENDING').is('deleted_at', null),
      db.from('anchors').select('chain_timestamp')
        .eq('status', 'SECURED').is('deleted_at', null)
        .order('chain_timestamp', { ascending: false })
        .limit(1),
      db.from('anchors').select('*', { count: 'exact', head: true })
        .is('deleted_at', null)
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    ]);
    return {
      total_secured: securedCount ?? 0,
      total_pending: pendingCount ?? 0,
      last_secured_at: lastSecured?.[0]?.chain_timestamp ?? null,
      last_24h_count: last24hCount ?? 0,
    };
  } catch (err) {
    logger.warn({ error: err }, 'fetchAnchorStats: Supabase query failed, returning zeros');
    return { total_secured: 0, total_pending: 0, last_secured_at: null, last_24h_count: 0 };
  }
}
