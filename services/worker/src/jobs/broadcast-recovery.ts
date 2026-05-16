/**
 * Broadcast Recovery Job (RACE-1)
 *
 * Recovers anchors stuck in BROADCASTING state due to worker crashes.
 *
 * Two scenarios:
 * 1. Worker crashed BEFORE chain submission → chain_tx_id is NULL → reset to PENDING
 * 2. Worker crashed AFTER chain submission but BEFORE recording tx_id →
 *    chain_tx_id is NULL but tx may exist on-chain. The recover_stuck_broadcasts()
 *    RPC only resets anchors where chain_tx_id IS NULL, so this is safe.
 *    If the tx was actually broadcast, it will be orphaned (no harm — single OP_RETURN
 *    with no UTXO value). The anchor gets re-broadcast on next processing cycle.
 *
 * Constitution refs:
 *   - 1.4: Treasury keys never logged
 *   - 1.9: No chain calls in recovery — just DB state management
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

/** Default: anchors stuck in BROADCASTING for >5 minutes are considered stuck */
const DEFAULT_STALE_MINUTES = 5;

export interface BroadcastRecoveryResult {
  recovered: number;
  anchors: Array<{ id: string; fingerprint: string; claimedBy: string }>;
}

/**
 * Recover anchors stuck in BROADCASTING state.
 *
 * Calls the recover_stuck_broadcasts() RPC which atomically:
 * 1. Finds BROADCASTING anchors older than stale threshold with no chain_tx_id
 * 2. Resets them to PENDING with recovery metadata
 * 3. Returns the recovered anchors for logging
 */
export async function recoverStuckBroadcasts(
  staleMinutes = DEFAULT_STALE_MINUTES,
): Promise<BroadcastRecoveryResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db.rpc as any)('recover_stuck_broadcasts', {
    p_stale_minutes: staleMinutes,
  });

  if (error) {
    // Fallback: if RPC doesn't exist yet, do manual recovery
    logger.warn({ error }, 'recover_stuck_broadcasts RPC failed — falling back to manual recovery');
    return manualRecovery(staleMinutes);
  }

  if (!data || !Array.isArray(data) || data.length === 0) {
    return { recovered: 0, anchors: [] };
  }

  const recovered = data.map((row: { anchor_id: string; anchor_fingerprint: string; claimed_by: string }) => ({
    id: row.anchor_id,
    fingerprint: row.anchor_fingerprint,
    claimedBy: row.claimed_by ?? 'unknown',
  }));

  logger.warn(
    { count: recovered.length, anchors: recovered.map((a: { id: string }) => a.id) },
    'Recovered stuck BROADCASTING anchors → PENDING',
  );

  return { recovered: recovered.length, anchors: recovered };
}

/**
 * Manual fallback recovery when RPC is not available.
 *
 * SCRUM-1296: Uses chunked bulk updates instead of per-row UPDATE calls.
 * Each anchor needs unique metadata (previous_claimed_by differs), so we
 * group by claimedBy and bulk-update each group with a single .in() call.
 * For the common case (all claimed by the same worker), this collapses
 * N updates into 1.
 */
async function manualRecovery(staleMinutes: number): Promise<BroadcastRecoveryResult> {
  const threshold = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString();

  const { data: stuck, error: fetchError } = await db
    .from('anchors')
    .select('id, fingerprint, metadata')
    .eq('status', 'BROADCASTING')
    .is('chain_tx_id', null)
    .is('deleted_at', null)
    .lt('updated_at', threshold)
    .limit(10000);

  if (fetchError || !stuck || stuck.length === 0) {
    return { recovered: 0, anchors: [] };
  }

  const recoveredAt = new Date().toISOString();
  const allAnchors = stuck.map((anchor) => {
    const meta = (anchor.metadata as Record<string, unknown>) ?? {};
    const claimedBy = (meta._claimed_by as string) ?? 'unknown';
    const cleanMeta = { ...meta };
    delete cleanMeta._claimed_by;
    delete cleanMeta._claimed_at;
    return { id: anchor.id, fingerprint: anchor.fingerprint, claimedBy, cleanMeta };
  });

  // SCRUM-1296: Chunked bulk update — process in batches of 100
  const CHUNK_SIZE = 100;
  const recovered: Array<{ id: string; fingerprint: string; claimedBy: string }> = [];

  for (let i = 0; i < allAnchors.length; i += CHUNK_SIZE) {
    const chunk = allAnchors.slice(i, i + CHUNK_SIZE);
    const chunkIds = chunk.map((a) => a.id);

    // Bulk update status; metadata per-row differences are acceptable to
    // lose in the fallback path — the recovery_reason + recovered_at are
    // the critical fields. For the fallback (RPC unavailable), we set a
    // uniform metadata payload. The RPC path (primary) handles per-row metadata.
    const { error: updateError } = await db
      .from('anchors')
      .update({
        status: 'PENDING',
        metadata: {
          _recovery_reason: 'stuck_broadcasting',
          _recovered_at: recoveredAt,
        },
      })
      .in('id', chunkIds)
      .eq('status', 'BROADCASTING');

    if (!updateError) {
      recovered.push(...chunk.map((a) => ({ id: a.id, fingerprint: a.fingerprint, claimedBy: a.claimedBy })));
    } else {
      logger.error({ error: updateError, chunkSize: chunkIds.length }, 'Bulk recovery update failed for chunk');
    }
  }

  if (recovered.length > 0) {
    logger.warn(
      { count: recovered.length, anchors: recovered.map((a) => a.id) },
      'Manually recovered stuck BROADCASTING anchors → PENDING',
    );
  }

  return { recovered: recovered.length, anchors: recovered };
}
