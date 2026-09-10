/**
 * Recover stale BROADCASTING/SUBMITTED anchors through the bounded SQL RPC.
 * Migrations 0442/0449 preserve the null-txid, deleted-row and durable journal guards
 * under row locks. Recovery eligibility belongs in that transaction.
 *
 * The former manual fallback read journal protection once and then reset rows
 * with only an id/status CAS. A newly persisted txid or journal could therefore
 * be overwritten, and zero-row updates were counted as recovered. Missing or
 * unhealthy RPCs now defer work, leaving anchors intact for the next cron tick.
 * Both migrations must be installed before deploying this worker.
 */
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { reconcileTxidJournals } from './batch-anchor.js';

const DEFAULT_STALE_MINUTES = 5;
export const RECOVERY_BATCH_SIZE = 500;
export const MAX_RECOVERY_PASSES = 40;
export const RECOVERY_TIME_BUDGET_MS = 90_000;
const LOG_ID_SAMPLE = 50;

export interface RecoveredAnchor {
  id: string;
  fingerprint: string;
  claimedBy: string;
}
export interface BroadcastRecoveryResult {
  recovered: number;
  anchors: RecoveredAnchor[];
  /** Bounded SQL requests actually attempted. */
  passes: number;
  /** Work may remain, including after an unknown transport outcome. */
  incomplete: boolean;
}
interface RecoveryRow {
  anchor_id: string;
  anchor_fingerprint: string;
  claimed_by: string | null;
}
function isRecoveryRow(value: unknown): value is RecoveryRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.anchor_id === 'string' && row.anchor_id.length > 0
    && typeof row.anchor_fingerprint === 'string' && row.anchor_fingerprint.length > 0
    && (row.claimed_by === null || typeof row.claimed_by === 'string');
}
function deferred(): BroadcastRecoveryResult {
  return { recovered: 0, anchors: [], passes: 0, incomplete: true };
}

// A slow journal request cannot be cancelled through its current interface.
// Hold this guard until it settles, so the two-minute in-process cron cannot
// stack work. Other worker instances remain protected by SQL row locking.
let running = false;
export async function recoverStuckBroadcasts(
  staleMinutes = DEFAULT_STALE_MINUTES,
): Promise<BroadcastRecoveryResult> {
  if (running) {
    logger.warn('Broadcast recovery already running — deferring this invocation');
    return deferred();
  }
  running = true;
  const deadline = Date.now() + RECOVERY_TIME_BUDGET_MS;
  try {
    return await runRecovery(staleMinutes, deadline);
  } catch (error) {
    logger.error({ error }, 'Broadcast recovery initialization failed — deferring generic recovery');
    return deferred();
  } finally {
    running = false;
  }
}

async function runRecovery(staleMinutes: number, deadline: number): Promise<BroadcastRecoveryResult> {
  const journal = await reconcileTxidJournals();
  if (!journal.protectionLoaded) {
    logger.error('Txid journal protection unavailable — refusing generic stale recovery');
    return deferred();
  }
  if (journal.scanned > 0) {
    logger.info(
      { scanned: journal.scanned, adopted: journal.adopted, reverted: journal.reverted, held: journal.held },
      'Durable txid journal recovery pass complete',
    );
  }

  const anchors: RecoveredAnchor[] = [];
  const recoveredIds = new Set<string>();
  let passes = 0;
  let incomplete = false;
  let drained = false;
  while (passes < MAX_RECOVERY_PASSES) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      incomplete = true;
      logger.warn(
        { passes, recovered: anchors.length, incomplete: true, budgetMs: RECOVERY_TIME_BUDGET_MS },
        'Stuck-broadcast recovery hit its time budget — the next cron tick continues',
      );
      break;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remainingMs);
    passes++;
    try {
      const { data, error } = await db.rpc('recover_stuck_broadcasts', {
        p_stale_minutes: staleMinutes,
        p_limit: RECOVERY_BATCH_SIZE,
      }).abortSignal(controller.signal);
      if (error) {
        // Absence, permission failures and transport failures all defer. A
        // transport failure may follow a committed reset; the next SQL call
        // re-evaluates current status and cannot reset the same claim twice.
        logger.error({ error, pass: passes, recovered: anchors.length },
          'recover_stuck_broadcasts RPC failed — deferring recovery without client-side writes');
        incomplete = true;
        break;
      }
      if (!Array.isArray(data) || data.length > RECOVERY_BATCH_SIZE || !data.every(isRecoveryRow)
        || new Set(data.map((row) => row.anchor_id)).size !== data.length
        || data.some((row) => recoveredIds.has(row.anchor_id))) {
        logger.error({ pass: passes, recovered: anchors.length },
          'recover_stuck_broadcasts returned an invalid reply — recovery outcome is unknown');
        incomplete = true;
        break;
      }
      for (const row of data) {
        recoveredIds.add(row.anchor_id);
        anchors.push({ id: row.anchor_id, fingerprint: row.anchor_fingerprint, claimedBy: row.claimed_by ?? 'unknown' });
      }
      logger.info({ pass: passes, recovered: data.length, totalRecovered: anchors.length },
        'Stuck-broadcast recovery pass complete');
      if (data.length < RECOVERY_BATCH_SIZE) {
        drained = true;
        break;
      }
    } catch (error) {
      logger.error({ error, pass: passes, recovered: anchors.length },
        'recover_stuck_broadcasts request threw — preserving acknowledged recovery progress');
      incomplete = true;
      break;
    } finally {
      clearTimeout(timeout);
    }
  }
  if (!drained && !incomplete && passes >= MAX_RECOVERY_PASSES) {
    incomplete = true;
    logger.warn({ passes, recovered: anchors.length, incomplete: true, maxPasses: MAX_RECOVERY_PASSES },
      'Stuck-broadcast recovery hit its pass budget — the next cron tick continues');
  }
  if (anchors.length > 0) {
    logger.warn({ count: anchors.length, passes, incomplete,
      anchorSample: anchors.slice(0, LOG_ID_SAMPLE).map((anchor) => anchor.id),
      sampleTruncated: anchors.length > LOG_ID_SAMPLE },
    'Recovered stuck BROADCASTING/SUBMITTED anchors → PENDING');
  }
  return { recovered: anchors.length, anchors, passes, incomplete };
}
