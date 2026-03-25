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
    .limit(100);

  if (fetchError || !stuck || stuck.length === 0) {
    return { recovered: 0, anchors: [] };
  }

  const recovered: Array<{ id: string; fingerprint: string; claimedBy: string }> = [];

  for (const anchor of stuck) {
    const meta = (anchor.metadata as Record<string, unknown>) ?? {};
    const claimedBy = (meta._claimed_by as string) ?? 'unknown';

    const cleanMeta = { ...meta };
    delete cleanMeta._claimed_by;
    delete cleanMeta._claimed_at;

    const { error: updateError } = await db
      .from('anchors')
      .update({
        status: 'PENDING',
        metadata: {
          ...cleanMeta,
          _recovery_reason: 'stuck_broadcasting',
          _recovered_at: new Date().toISOString(),
          _previous_claimed_by: claimedBy,
        },
      })
      .eq('id', anchor.id)
      .eq('status', 'BROADCASTING');

    if (!updateError) {
      recovered.push({ id: anchor.id, fingerprint: anchor.fingerprint, claimedBy });
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
