/**
 * Broadcast Recovery Job (RACE-1, extended by F-3 / migration 0379,
 * bounded into batches by SCRUM-4520 / migration 0442)
 *
 * Recovers anchors stuck in BROADCASTING state due to worker crashes, AND
 * (F-3, docs/staging/SOAK-FINDINGS-2026-08.md) anchors left SUBMITTED with a
 * NULL chain_tx_id — the shape a broadcast attempt produces if it fails
 * between the status write and the txid write. Before migration 0379 that
 * second shape had no recovery path at all: no scheduled job's WHERE clause
 * ever selected it. Proven live during the 72h soak (fixture
 * `5eed0000-...-c1` sat unrecovered for days).
 *
 * Durable journal recovery runs first. Only unjournaled stale claims may enter
 * the generic reset; PENDING and HELD journal cohorts are excluded atomically
 * by migration 0358 (extended to the SUBMITTED branch by 0379) and by the
 * manual compatibility fallback below.
 *
 * ## Why every path here is bounded (SCRUM-4520, rig incident 2026-09-07)
 *
 * On staging rig `txvvrxngyfnnqahujbld` a batch-anchoring run was SIGTERM'd
 * mid-flight, leaving 10,000 anchors BROADCASTING with a NULL chain_tx_id.
 * `POST /jobs/recover-broadcasts` then returned 200 and recovered NOTHING on
 * every pass for ~10 minutes, because all three layers were unbounded:
 *
 *   1. `recover_stuck_broadcasts()` took no LIMIT. Its single UPDATE tried to
 *      claim all 10,000 rows and hit the function's own 60s statement_timeout
 *      (SQLSTATE 57014) every time — no forward progress, ever.
 *   2. Any RPC error, including that timeout, was routed into `manualRecovery`
 *      — a fallback written for "the RPC does not exist yet". It SELECTed
 *      10,000 rows and issued 10,000 individual PostgREST UPDATEs, 100
 *      concurrently, against a database that was already timing out. That is
 *      what drove the rig's PostgREST into Cloudflare 520s.
 *   3. `manualRecovery` returned `{recovered: 0}` for a fetch failure and for
 *      a genuinely-empty cohort alike, and logged only when it recovered
 *      something — so a total stall looked exactly like "nothing to do".
 *
 * The cohort had to be deleted by hand. A stuck BROADCASTING cohort
 * head-of-line blocks batch anchoring (`batch_insert_anchors` keeps returning
 * the same oldest-first rows, `partitionRecordAnchors` buckets the
 * BROADCASTING rows nowhere, and the drain reports "no new pending" with a
 * 200), so this is a liveness bug, not a cosmetic one.
 *
 * Fix, in three parts:
 *   - The RPC takes `p_limit` (migration 0442) so a single call always
 *     completes well inside the 60s statement timeout.
 *   - This job loops over bounded batches until a pass comes back short,
 *     under a pass cap AND a wall-clock budget (the recovery cron fires every
 *     2 minutes with no reentrancy guard — see routes/scheduled.ts).
 *   - Every pass logs what it actually recovered, and the result carries
 *     `passes` / `incomplete`, so a stalled recovery is visible rather than a
 *     silent 200.
 *
 * A statement timeout is NOT treated as "the RPC is missing": only genuine
 * absence (schema-cache lag right after a deploy, a pre-0358 database) drops
 * to the JS fallback. Every other RPC error aborts the invocation loudly.
 *
 * Constitution refs:
 *   - 1.4: Treasury keys never logged
 *   - 1.9: Chain lookup is read-only and tri-state; no recovery rebroadcast
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { reconcileTxidJournals } from './batch-anchor.js';

/** Default: anchors stuck in BROADCASTING for >5 minutes are considered stuck */
const DEFAULT_STALE_MINUTES = 5;

/**
 * Rows claimed per RPC call / per manual SELECT. Sized so one call finishes
 * far inside the RPC's 60s statement_timeout even when the journal-protection
 * NOT EXISTS has to be evaluated for every candidate row. Migration 0442
 * clamps the server side to the same order of magnitude, so a caller cannot
 * re-create the unbounded sweep by passing a huge limit.
 */
export const RECOVERY_BATCH_SIZE = 500;

/**
 * Upper bound on batches per invocation (20,000 rows). The cron re-runs every
 * 2 minutes, so hitting this cap defers work rather than dropping it.
 */
export const MAX_RECOVERY_PASSES = 40;

/**
 * Wall-clock budget per invocation. `scheduleInProcess` has no reentrancy
 * guard, so an invocation must reliably finish inside the 2-minute cron
 * interval rather than stacking up behind itself.
 */
export const RECOVERY_TIME_BUDGET_MS = 90_000;

/** How many recovered anchor ids a single log line may carry. */
const LOG_ID_SAMPLE = 50;

/** Concurrent per-row UPDATEs inside one manual batch (SCRUM-1296). */
const MANUAL_UPDATE_CHUNK = 100;

export interface RecoveredAnchor {
  id: string;
  fingerprint: string;
  claimedBy: string;
}

export interface BroadcastRecoveryResult {
  recovered: number;
  anchors: RecoveredAnchor[];
  /** Bounded batches actually attempted. */
  passes: number;
  /**
   * True when the invocation stopped with work potentially still outstanding
   * — a budget cap, a failing database, or a batch that could not be updated.
   * A caller must never read `recovered: 0` as "the queue is clean".
   */
  incomplete: boolean;
}

/**
 * PostgREST/Postgres codes that mean "this function does not exist here" — the
 * only condition the JS fallback was ever designed for. Deliberately narrow:
 * routing a statement timeout (57014) or a permission error down this path is
 * what turned the 2026-09-07 stall into a database-melting fan-out.
 */
const RPC_ABSENT_CODES = new Set(['PGRST202', 'PGRST203', 'PGRST205', '42883']);

function isRpcAbsent(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code && RPC_ABSENT_CODES.has(code)) return true;
  const message = String((error as { message?: string } | null)?.message ?? '').toLowerCase();
  return message.includes('could not find the function') || message.includes('does not exist');
}

/** One bounded batch's outcome, from either the RPC or the manual fallback. */
interface RecoveryBatch {
  rows: RecoveredAnchor[];
  /** Candidate rows the batch claimed/read — a short read means the cohort is drained. */
  fetched: number;
  /** The batch could not run at all; the invocation must stop and say so. */
  aborted: boolean;
}

/**
 * Recover anchors stuck in BROADCASTING state, and (F-3, migration 0379)
 * anchors stuck SUBMITTED with a NULL chain_tx_id.
 *
 * Loops over bounded batches (SCRUM-4520). Each RPC call atomically:
 * 1. Finds up to `p_limit` BROADCASTING or SUBMITTED anchors older than the
 *    stale threshold with no chain_tx_id, oldest first (a SUBMITTED anchor
 *    that already carries a real chain_tx_id is never touched — the broadcast
 *    happened; resetting it would double-spend treasury sats on the next drain)
 * 2. Resets them to PENDING with recovery metadata
 * 3. Returns the recovered anchors for logging
 *
 * The loop stops when a pass comes back short (cohort drained), when a pass
 * recovers nothing out of a full batch (the database is refusing the writes),
 * or when the pass/time budget is spent — the last three all set `incomplete`.
 */
export async function recoverStuckBroadcasts(
  staleMinutes = DEFAULT_STALE_MINUTES,
): Promise<BroadcastRecoveryResult> {
  // SCRUM-2692: exact txid ADOPT/REVERT/HOLD always precedes the generic
  // stale-claim RPC. The RPC itself repeats HELD protection transactionally.
  const journal = await reconcileTxidJournals();
  if (!journal.protectionLoaded) {
    logger.error('Txid journal protection unavailable — refusing generic stale recovery');
    return { recovered: 0, anchors: [], passes: 0, incomplete: true };
  }
  if (journal.scanned > 0) {
    logger.info(
      { scanned: journal.scanned, adopted: journal.adopted, reverted: journal.reverted, held: journal.held },
      'Durable txid journal recovery pass complete',
    );
  }

  const deadline = Date.now() + RECOVERY_TIME_BUDGET_MS;
  const anchors: RecoveredAnchor[] = [];
  /** Set once the RPC is proven absent; every later pass uses the JS fallback. */
  let manualProtectedIds: Set<string> | null = null;
  let usingManual = false;
  let passes = 0;
  let incomplete = false;
  let drained = false;

  while (passes < MAX_RECOVERY_PASSES) {
    if (Date.now() >= deadline) {
      incomplete = true;
      logger.warn(
        { passes, recovered: anchors.length, incomplete: true, budgetMs: RECOVERY_TIME_BUDGET_MS },
        'Stuck-broadcast recovery hit its time budget — rows may remain; the next cron tick continues',
      );
      break;
    }

    if (!usingManual) {
      const { data, error } = await db.rpc('recover_stuck_broadcasts', {
        p_stale_minutes: staleMinutes,
        p_limit: RECOVERY_BATCH_SIZE,
      });

      if (error) {
        if (isRpcAbsent(error)) {
          // The historical fallback: schema-cache lag right after a deploy, or
          // a database that predates 0358. Switch modes without consuming a
          // pass, then re-enter the loop.
          logger.warn({ error }, 'recover_stuck_broadcasts RPC unavailable — falling back to manual recovery');
          manualProtectedIds = await loadProtectedJournalAnchorIds();
          if (!manualProtectedIds) {
            logger.error('journal protection scan failed — refusing manual stale recovery');
            incomplete = true;
            break;
          }
          usingManual = true;
          continue;
        }
        // 57014 (statement timeout), permission errors, connection failures:
        // the database is unhealthy or overloaded. Firing thousands of
        // individual PostgREST UPDATEs at it is precisely the wrong response.
        logger.error(
          { error, pass: passes + 1, recovered: anchors.length },
          'recover_stuck_broadcasts RPC failed — aborting recovery, NOT falling back to per-row updates',
        );
        incomplete = true;
        break;
      }

      passes++;
      const rows = Array.isArray(data) ? data : [];
      const mapped = rows.map(
        (row: { anchor_id: string; anchor_fingerprint: string; claimed_by: string }) => ({
          id: row.anchor_id,
          fingerprint: row.anchor_fingerprint,
          claimedBy: row.claimed_by ?? 'unknown',
        }),
      );
      anchors.push(...mapped);
      if (mapped.length > 0) {
        logger.info(
          { pass: passes, recovered: mapped.length, totalRecovered: anchors.length },
          'Stuck-broadcast recovery pass complete',
        );
      }
      // A short batch means the RPC found nothing more to claim (rows still
      // locked by a concurrent sweep are that sweep's to finish).
      if (rows.length < RECOVERY_BATCH_SIZE) {
        drained = true;
        break;
      }
      continue;
    }

    const batch = await manualRecoveryBatch(staleMinutes, RECOVERY_BATCH_SIZE, manualProtectedIds!, passes + 1);
    if (batch.aborted) {
      incomplete = true;
      break;
    }
    passes++;
    anchors.push(...batch.rows);
    if (batch.fetched < RECOVERY_BATCH_SIZE) {
      drained = true;
      break;
    }
    if (batch.rows.length === 0) {
      // A full batch was read and not one row could be updated. Re-reading the
      // same rows would spin; stop and make it visible.
      logger.error(
        { pass: passes, fetched: batch.fetched, recovered: 0 },
        'Manual recovery pass updated zero of the rows it fetched — stopping to avoid a spin',
      );
      incomplete = true;
      break;
    }
  }

  if (!drained && !incomplete && passes >= MAX_RECOVERY_PASSES) {
    incomplete = true;
    logger.warn(
      { passes, recovered: anchors.length, incomplete: true, maxPasses: MAX_RECOVERY_PASSES },
      'Stuck-broadcast recovery hit its pass budget — rows remain; the next cron tick continues',
    );
  }

  if (anchors.length > 0) {
    // The RPC's public row shape is deliberately unchanged by migrations 0379
    // and 0442 (no per-row previous-status column), so a
    // BROADCASTING/SUBMITTED breakdown isn't available here without an extra
    // query; each recovered row's `anchors.metadata->>'_recovered_from_status'`
    // carries that provenance for post-hoc investigation.
    logger.warn(
      {
        count: anchors.length,
        passes,
        incomplete,
        // Never emit 10k ids on one pino line — that was its own hazard during
        // the 2026-09-07 incident.
        anchorSample: anchors.slice(0, LOG_ID_SAMPLE).map((a) => a.id),
        sampleTruncated: anchors.length > LOG_ID_SAMPLE,
      },
      'Recovered stuck BROADCASTING/SUBMITTED anchors → PENDING',
    );
  }

  return { recovered: anchors.length, anchors, passes, incomplete };
}

/**
 * One bounded manual-fallback batch, used only when the RPC is genuinely
 * absent.
 *
 * F-3 (migration 0379): claims BOTH the BROADCASTING branch (RACE-1) and the
 * SUBMITTED-with-NULL-chain_tx_id branch, mirroring the RPC exactly — a row
 * that already carries a real chain_tx_id is never touched regardless of
 * status, and each row's `_recovery_reason` / compare-and-set filter tracks
 * its OWN previous status (a mixed BROADCASTING+SUBMITTED result set must
 * never cross-tag or cross-filter between the two).
 *
 * SCRUM-4520: reads at most `limit` rows, oldest first, so head-of-line
 * blockers clear first and one pass can never fan out over a whole 10k
 * cohort. The caller loops. A fetch failure is reported as `aborted` and
 * logged — it must never be laundered into a silent `recovered: 0`.
 *
 * SCRUM-1296: Uses chunked bulk updates instead of per-row UPDATE calls.
 * Each anchor needs unique metadata (previous_claimed_by differs), so the
 * per-row payloads are issued in chunks rather than one at a time.
 */
async function manualRecoveryBatch(
  staleMinutes: number,
  limit: number,
  protectedAnchorIds: Set<string>,
  passNumber: number,
): Promise<RecoveryBatch> {
  const threshold = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString();

  const { data: stuck, error: fetchError } = await db
    .from('anchors')
    .select('id, fingerprint, status, metadata')
    .in('status', ['BROADCASTING', 'SUBMITTED'])
    .is('chain_tx_id', null)
    .is('deleted_at', null)
    .lt('updated_at', threshold)
    .order('updated_at', { ascending: true })
    .limit(limit);

  if (fetchError) {
    logger.error(
      { error: fetchError, pass: passNumber, limit },
      'Manual recovery fetch failed — recovery made no progress this pass',
    );
    return { rows: [], fetched: 0, aborted: true };
  }
  if (!stuck || stuck.length === 0) {
    return { rows: [], fetched: 0, aborted: false };
  }

  const recoveredAt = new Date().toISOString();
  const candidates = stuck
    .filter((anchor) => !protectedAnchorIds.has(anchor.id))
    .map((anchor) => {
      const meta = (anchor.metadata as Record<string, unknown>) ?? {};
      const claimedBy = (meta._claimed_by as string) ?? 'unknown';
      const cleanMeta = { ...meta };
      delete cleanMeta._claimed_by;
      delete cleanMeta._claimed_at;
      const previousStatus = anchor.status as 'BROADCASTING' | 'SUBMITTED';
      return { id: anchor.id, fingerprint: anchor.fingerprint, claimedBy, cleanMeta, previousStatus };
    });

  const recovered: RecoveredAnchor[] = [];

  for (let i = 0; i < candidates.length; i += MANUAL_UPDATE_CHUNK) {
    const chunk = candidates.slice(i, i + MANUAL_UPDATE_CHUNK);

    // Per-anchor update to preserve existing metadata — each anchor may
    // have different business-critical fields in metadata that must survive.
    // The compare-and-set `.eq('status', anchor.previousStatus)` guards
    // against a concurrent transition landing between the SELECT above and
    // this UPDATE (e.g. a worker legitimately finishing the broadcast in the
    // interim) — exactly the same race the RPC's FOR UPDATE SKIP LOCKED
    // closes atomically; this JS fallback only ever runs when the RPC itself
    // is unavailable.
    const results = await Promise.allSettled(
      chunk.map((anchor) =>
        db
          .from('anchors')
          .update({
            status: 'PENDING',
            metadata: {
              ...anchor.cleanMeta,
              _recovery_reason:
                anchor.previousStatus === 'BROADCASTING' ? 'stuck_broadcasting' : 'stuck_submitted_null_txid',
              _recovered_at: recoveredAt,
              _recovered_from_status: anchor.previousStatus,
              _previous_claimed_by: anchor.claimedBy,
            },
          })
          .eq('id', anchor.id)
          .eq('status', anchor.previousStatus),
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

  const recoveredIds = new Set(recovered.map((a) => a.id));
  const fromBroadcasting = candidates.filter(
    (a) => a.previousStatus === 'BROADCASTING' && recoveredIds.has(a.id),
  ).length;

  // Always logged, including a zero-recovery pass — a stalled recovery has to
  // be visible in the worker log, not inferred from an unchanged row count.
  logger.warn(
    {
      pass: passNumber,
      fetched: stuck.length,
      eligible: candidates.length,
      recovered: recovered.length,
      fromBroadcasting,
      fromSubmitted: recovered.length - fromBroadcasting,
    },
    'Manual recovery pass complete',
  );

  return { rows: recovered, fetched: stuck.length, aborted: false };
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
