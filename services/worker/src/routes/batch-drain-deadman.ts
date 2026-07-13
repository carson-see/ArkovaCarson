/**
 * Batch-drain dead-man's-switch (Lane-1 S3.5 / BTC-real).
 *
 * The nightly ~3am Bitcoin batch-drain cron is correctly wired to Cloud
 * Scheduler (daily-anchor-flush → POST /jobs/batch-anchors?force=true); the
 * silent node-cron-on-throttled-Cloud-Run trap does NOT apply. But a HEALTHY
 * flush on an empty queue and a STALLED pipeline both surface as HTTP 200 +
 * EMPTY, and /health hardcodes anchoring.status='ok'. There is no loud signal
 * that would tell an operator "the 3am drain has stopped landing while a real
 * backlog is aging."
 *
 * This pure evaluator IS that signal. It is intentionally side-effect-free so
 * it can be (a) folded into the /health anchoring check and (b) reused by any
 * future alert path (Sentry monitor / Cloud Monitoring) without a DB or clock
 * dependency — `nowMs` and every input are injected.
 *
 * Steady-state truth (prod 2026-07-07): 2,972,263 SECURED / 0 PENDING. An
 * EMPTY queue is NEVER an alarm — the drain firing and no-oping on an empty
 * queue is correct behaviour, not a fault.
 *
 * Constitution refs:
 *   - 1.5: signal states what is measured (backlog age / batch recency), not asserted.
 *   - 1.9: /health always available; this only enriches anchoring.status.
 */

/**
 * Age ceiling for a PENDING anchor before the drain is expected to have swept
 * it. Mirrors batch-anchor.ts MAX_ANCHOR_AGE_MS (Trigger B fires at this age;
 * the 3am forced flush ignores age entirely) — kept as a LOCAL constant so this
 * pure monitoring module has no runtime import of the batch-anchor job graph
 * (which pulls config/db/chain). A pin test in batch-drain-deadman.test.ts
 * asserts this stays equal to the batch-anchor source of truth.
 */
export const DRAIN_AGE_CEILING_MS = 3 * 60 * 60 * 1000; // 3 hours

/**
 * Max time a completed batch may be absent while a backlog exists before the
 * nightly flush is considered stalled. The daily flush runs every ~24h (plus a
 * redundant every-30-min job), so > 24h with a non-empty queue means the drain
 * is not landing.
 */
export const STALE_BATCH_MAX_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface BatchDrainSignal {
  /** Count of PENDING anchors, or null if the count probe failed. */
  pendingCount: number | null;
  /** ISO timestamp of the oldest PENDING anchor, or null if none / probe failed. */
  oldestPendingAt: string | null;
  /** ISO timestamp of the most recent completed batch, or null if never / probe failed. */
  lastBatchAt: string | null;
  /** Injected wall clock (ms since epoch). */
  nowMs: number;
}

export type BatchDrainReason =
  | 'ok'
  | 'backlog_aged'
  | 'batch_stale'
  | 'backlog_age_unknown';

export interface BatchDrainVerdict {
  status: 'ok' | 'warning';
  stalled: boolean;
  reason: BatchDrainReason;
  /** Age of the oldest pending anchor in ms, when known. */
  oldestPendingAgeMs: number | null;
  /** Time since the last completed batch in ms, when known. */
  batchAgeMs: number | null;
}

function parseAgeMs(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return nowMs - t;
}

/**
 * Evaluate the batch-drain dead-man's-switch.
 *
 * Fires 'warning' (loud, machine-detectable) only when a PENDING backlog is
 * PROVEN to exist AND the drain is demonstrably not clearing it:
 *   - backlog_age_unknown: backlog exists but its age is unmeasurable → fail loud.
 *   - backlog_aged:        oldest pending ≥ MAX_ANCHOR_AGE_MS (drain should have swept it).
 *   - batch_stale:         no batch completed in > STALE_BATCH_MAX_MS (nightly flush not landing).
 *
 * Never fires on an empty queue (pendingCount 0) or an unproven backlog
 * (pendingCount null) — that avoids false alarms on the correct steady state
 * and on transient count-probe blips.
 */
export function evaluateBatchDrainHealth(signal: BatchDrainSignal): BatchDrainVerdict {
  const { pendingCount, oldestPendingAt, lastBatchAt, nowMs } = signal;

  const oldestPendingAgeMs = parseAgeMs(oldestPendingAt, nowMs);
  const batchAgeMs = parseAgeMs(lastBatchAt, nowMs);

  const ok = (reason: BatchDrainReason = 'ok'): BatchDrainVerdict => ({
    status: 'ok',
    stalled: false,
    reason,
    oldestPendingAgeMs,
    batchAgeMs,
  });

  // No proven backlog → nothing to alarm on. Covers the correct steady state
  // (empty queue) and transient count-probe failures (pendingCount null).
  if (pendingCount === null || pendingCount <= 0) {
    return ok();
  }

  const warn = (reason: BatchDrainReason): BatchDrainVerdict => ({
    status: 'warning',
    stalled: true,
    reason,
    oldestPendingAgeMs,
    batchAgeMs,
  });

  // Backlog exists but we cannot measure its age → cannot prove freshness → fail loud.
  if (oldestPendingAgeMs === null) {
    return warn('backlog_age_unknown');
  }

  // Backlog aged past the drain's own age ceiling: the drain should have swept
  // it (Trigger B fires at MAX_ANCHOR_AGE_MS; the 3am forced flush ignores age
  // entirely). Still pending ⇒ the drain is not running / not clearing.
  if (oldestPendingAgeMs >= DRAIN_AGE_CEILING_MS) {
    return warn('backlog_aged');
  }

  // Young backlog, but no batch has landed in > 24h (or ever): the nightly 3am
  // flush is not producing output while work is queued.
  if (batchAgeMs === null || batchAgeMs > STALE_BATCH_MAX_MS) {
    return warn('batch_stale');
  }

  return ok();
}
