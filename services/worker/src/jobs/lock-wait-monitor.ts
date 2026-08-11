/**
 * Lock-wait monitor — the EARLY signal for the 2026-08-11 FIFO lock-barrier P0.
 *
 * Timeline that motivates the cadence: the barrier on `public.organizations`
 * formed at ~16:35Z when an unguarded `ALTER TABLE` queued behind two ~50-minute
 * readers. User impact did not start until 16:40:11Z. Everything else we have
 * only sees the impact — the `PGRST002` alarm fires once PostgREST has already
 * stopped serving, and the `/health` body alarm fires once the worker has
 * already gone degraded. This job is the only thing that can fire inside that
 * ~5-minute window, so it runs every minute.
 *
 * ## Output contract (do not change one half of this alone)
 *
 * Each waiting lock produces ONE structured log line carrying:
 *
 *     alert_type = "db_lock_wait"      <- the log-based metric's filter
 *     relation   = "public.<table>"    <- metric label
 *     lock_mode  = "<mode>"            <- metric label
 *
 * consumed by `scripts/gcp-setup/log-metrics/db-lock-wait.json` and alerted on
 * by `scripts/gcp-setup/alert-policies/db-lock-wait-page.json`. The pairing is
 * pinned by `lock-wait-monitor.test.ts`; drift between the two would silently
 * disarm the alarm, which is precisely the failure class this change removes.
 *
 * ## Known blind spot, stated rather than hidden
 *
 * This job reaches Postgres through PostgREST. Once a barrier has degraded
 * PostgREST far enough to emit `PGRST002`, this monitor goes blind too — it
 * will report `degraded`, not a lock wait. That is acceptable and by design:
 * this alarm's job is the ~5 minutes BEFORE PostgREST breaks, and the PGRST002
 * alarm is the backstop for everything after. Two alarms, two windows, neither
 * pretending to cover the other.
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { Sentry } from '../utils/sentry.js';
import { callRpc } from '../utils/rpc.js';

/** The literal the Cloud Monitoring log-based metric filters on. */
export const LOCK_WAIT_ALERT_TYPE = 'db_lock_wait';

/**
 * Only waits older than this are reported. 60s is far above any healthy
 * contention on this database and far below the 5-minute window we need to
 * fire inside.
 */
export const LOCK_WAIT_THRESHOLD_SECONDS = 60;

/**
 * Lock modes that a *barrier former* requests. A blocked AccessExclusiveLock
 * request is the thing that turns one slow statement into a full-database
 * stall, because every later request — whatever its mode — queues behind it.
 * Waiting locks in other modes are symptoms of someone else's barrier: still
 * worth a metric point, not worth a second page for the same incident.
 */
const BARRIER_FORMING_MODES = new Set([
  'AccessExclusiveLock',
  'ExclusiveLock',
  'ShareRowExclusiveLock',
]);

interface LockWaitRow {
  relation: string;
  lock_mode: string;
  wait_seconds: number;
  blocked_pid: number;
  blocking_pids: number[] | null;
}

export interface LockWait {
  relation: string;
  lockMode: string;
  waitSeconds: number;
  blockedPid: number;
  blockingPids: number[];
}

export interface LockWaitSnapshot {
  waits: LockWait[];
  /** True when the monitor could not read lock state at all. NOT a lock alert. */
  degraded: boolean;
}

/** `organizations` -> `public.organizations`; already-qualified names pass through. */
function qualify(relation: string): string {
  return relation.includes('.') ? relation : `public.${relation}`;
}

/** Returns null — never an empty array — when lock visibility was LOST rather than clear. */
async function fetchLockWaits(): Promise<LockWaitRow[] | null> {
  try {
    const { data, error } = await callRpc<LockWaitRow[]>(db, 'get_lock_waits', {
      p_min_wait_seconds: LOCK_WAIT_THRESHOLD_SECONDS,
    });
    if (error) {
      // Deliberately NOT tagged `alert_type: db_lock_wait`. "The monitor is
      // broken" and "a lock is stuck" are different incidents; sharing a
      // signal would make the alarm lie about which one is happening.
      logger.warn({ error, monitor: 'lock-wait-monitor' }, 'get_lock_waits RPC failed — lock visibility lost');
      return null;
    }
    return data ?? [];
  } catch (err) {
    logger.warn({ err, monitor: 'lock-wait-monitor' }, 'lock-wait-monitor threw — lock visibility lost');
    return null;
  }
}

export async function runLockWaitMonitor(): Promise<LockWaitSnapshot> {
  const rows = await fetchLockWaits();
  if (rows === null) return { waits: [], degraded: true };

  const waits: LockWait[] = rows.map((r) => ({
    relation: qualify(r.relation),
    lockMode: r.lock_mode,
    waitSeconds: Number(r.wait_seconds),
    blockedPid: r.blocked_pid,
    blockingPids: r.blocking_pids ?? [],
  }));

  if (waits.length === 0) {
    logger.info({ monitor: 'lock-wait-monitor' }, 'lock-wait-monitor green — no waits over threshold');
    return { waits, degraded: false };
  }

  for (const w of waits) {
    logger.warn(
      {
        alert_type: LOCK_WAIT_ALERT_TYPE,
        relation: w.relation,
        lock_mode: w.lockMode,
        wait_seconds: w.waitSeconds,
        blocked_pid: w.blockedPid,
        blocking_pids: w.blockingPids,
        threshold_seconds: LOCK_WAIT_THRESHOLD_SECONDS,
      },
      `Lock wait ${w.waitSeconds}s on ${w.relation} (${w.lockMode}) — possible FIFO barrier`,
    );

    if (BARRIER_FORMING_MODES.has(w.lockMode)) {
      try {
        Sentry.captureMessage(
          `Blocked ${w.lockMode} on ${w.relation} for ${w.waitSeconds}s — FIFO lock barrier forming`,
          {
            level: 'error',
            tags: {
              source: 'lock-wait-monitor',
              alert_type: LOCK_WAIT_ALERT_TYPE,
              relation: w.relation,
              lock_mode: w.lockMode,
            },
          },
        );
      } catch (err) {
        logger.warn({ err }, 'Failed to emit Sentry event for lock wait');
      }
    }
  }

  return { waits, degraded: false };
}
