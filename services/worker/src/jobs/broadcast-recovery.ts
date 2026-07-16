/**
 * Broadcast Recovery Job (RACE-1)
 *
 * Recovers anchors stuck in BROADCASTING state due to worker crashes.
 *
 * Durable journal recovery runs first. Only unjournaled stale claims may enter
 * the generic reset; PENDING and HELD journal cohorts are excluded atomically
 * by migration 0358 and by the manual compatibility fallback below.
 *
 * Constitution refs:
 *   - 1.4: Treasury keys never logged
 *   - 1.9: Chain lookup is read-only and tri-state; no recovery rebroadcast
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { reconcileTxidJournals } from './batch-anchor.js';
import type { S33RigB1ScenarioExecutionContext } from './s33-rig-b1-scenario.js';

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
  scenario?: S33RigB1ScenarioExecutionContext,
): Promise<BroadcastRecoveryResult> {
  if (scenario) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db.rpc as any)('recover_s33_rig_b1_scenario_broadcasts', {
      p_scenario_lease_id: scenario.scenarioLeaseId,
      p_generation: scenario.generation,
      p_scheduler_execution_id: scenario.schedulerExecutionId,
      p_namespace_id: scenario.namespaceId,
      p_worker_id: scenario.workerRevision,
      p_stale_minutes: staleMinutes,
    });
    if (error || !Array.isArray(data)) {
      throw new Error(`RIG-B1 exact recovery failed: ${(error as { message?: string } | null)?.message ?? 'invalid rows'}`);
    }
    const recovered = data.map((row: {
      anchor_id: string;
      anchor_fingerprint: string;
      claimed_by: string;
      correlated_drain_execution_id: string;
      fault_window_id: string;
    }) => ({
      id: row.anchor_id,
      fingerprint: row.anchor_fingerprint,
      claimedBy: row.claimed_by ?? 'unknown',
      correlatedDrainExecutionId: row.correlated_drain_execution_id,
      faultWindowId: row.fault_window_id,
    }));
    logger.info({
      event: 'rig-b1-recovery',
      schedulerExecutionId: scenario.schedulerExecutionId,
      scenarioId: scenario.scenarioId,
      faultWindowId: scenario.faultWindowId,
      recovered: recovered.length,
      correlations: recovered.map((row) => ({
        anchorId: row.id,
        correlatedDrainExecutionId: row.correlatedDrainExecutionId,
        faultWindowId: row.faultWindowId,
      })),
    }, 'RIG-B1 exact namespace recovery completed');
    return { recovered: recovered.length, anchors: recovered };
  }
  // SCRUM-2692: exact txid ADOPT/REVERT/HOLD always precedes the generic
  // stale-claim RPC. The RPC itself repeats HELD protection transactionally.
  const journal = await reconcileTxidJournals();
  if (!journal.protectionLoaded) {
    logger.error('Txid journal protection unavailable — refusing generic stale recovery');
    return { recovered: 0, anchors: [] };
  }
  if (journal.scanned > 0) {
    logger.info(
      { scanned: journal.scanned, adopted: journal.adopted, reverted: journal.reverted, held: journal.held },
      'Durable txid journal recovery pass complete',
    );
  }

  const { data, error } = await db.rpc('recover_stuck_broadcasts', {
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
  const protectedAnchorIds = await loadProtectedJournalAnchorIds();
  if (!protectedAnchorIds) {
    logger.error('journal protection scan failed — refusing manual stale recovery');
    return { recovered: 0, anchors: [] };
  }

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
  const allAnchors = stuck.filter((anchor) => !protectedAnchorIds.has(anchor.id)).map((anchor) => {
    const meta = (anchor.metadata as Record<string, unknown>) ?? {};
    const claimedBy = (meta._claimed_by as string) ?? 'unknown';
    const cleanMeta = { ...meta };
    delete cleanMeta._claimed_by;
    delete cleanMeta._claimed_at;
    return { id: anchor.id, fingerprint: anchor.fingerprint, claimedBy, cleanMeta };
  });

  // SCRUM-1296: Chunked bulk update — process in batches of 100
  // Each anchor gets its own metadata preserved (cleanMeta) plus recovery fields.
  const CHUNK_SIZE = 100;
  const recovered: Array<{ id: string; fingerprint: string; claimedBy: string }> = [];

  for (let i = 0; i < allAnchors.length; i += CHUNK_SIZE) {
    const chunk = allAnchors.slice(i, i + CHUNK_SIZE);

    // Per-anchor update to preserve existing metadata — each anchor may
    // have different business-critical fields in metadata that must survive.
    const results = await Promise.allSettled(
      chunk.map((anchor) =>
        db
          .from('anchors')
          .update({
            status: 'PENDING',
            metadata: {
              ...anchor.cleanMeta,
              _recovery_reason: 'stuck_broadcasting',
              _recovered_at: recoveredAt,
              _previous_claimed_by: anchor.claimedBy,
            },
          })
          .eq('id', anchor.id)
          .eq('status', 'BROADCASTING'),
      ),
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const anchor = chunk[j];
      if (result.status === 'fulfilled' && !result.value.error) {
        recovered.push({ id: anchor.id, fingerprint: anchor.fingerprint, claimedBy: anchor.claimedBy });
      } else {
        const err = result.status === 'rejected' ? result.reason : result.value.error;
        logger.error({ error: err, anchorId: anchor.id }, 'Recovery update failed for anchor');
      }
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

/**
 * Manual fallback protection for the narrow window where the SQL RPC is
 * unavailable. A missing journal table means a pre-0358 deployment and is
 * compatible with the old fallback; every other read failure is ambiguous and
 * therefore blocks recovery.
 */
async function loadProtectedJournalAnchorIds(): Promise<Set<string> | null> {
  try {
    const { data, error } = await db
      .from('anchor_txid_journal')
      .select('anchor_ids')
      .in('recovery_status', ['PENDING', 'HELD'])
      .limit(1000);
    if (error) {
      const code = (error as { code?: string }).code;
      const message = String((error as { message?: string }).message ?? '').toLowerCase();
      if (code === '42P01' || code === 'PGRST205' || message.includes('anchor_txid_journal') && message.includes('not found')) {
        return new Set();
      }
      logger.error({ error }, 'Txid journal protection scan failed');
      return null;
    }
    if ((data ?? []).length >= 1000) {
      logger.error('Txid journal protection scan reached its result cap');
      return null;
    }
    const ids = new Set<string>();
    for (const row of data ?? []) {
      for (const id of row.anchor_ids ?? []) ids.add(id);
    }
    return ids;
  } catch (error) {
    logger.error({ error }, 'Txid journal protection scan failed');
    return null;
  }
}
