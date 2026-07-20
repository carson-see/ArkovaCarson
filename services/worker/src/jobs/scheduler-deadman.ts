/**
 * Dead-man-with-actor-attribution evaluator (SCRUM-2900).
 *
 * routes/batch-drain-deadman.ts proves a drain STALL exists. This layer answers
 * the operator's next question — WHO or WHAT stopped it — by cross-referencing
 * the codified scheduler manifest against a per-job last-run signal:
 *
 *   - ENABLED job, run recently        → healthy, no finding worth paging.
 *   - ENABLED job, overdue / no signal → UNATTRIBUTED stall. Worst case: the
 *     job is supposed to be running and has gone silent with no one owning the
 *     pause. This FIRES (pages a human).
 *   - PAUSED job, silent               → EXPECTED silence, ATTRIBUTED to the
 *     actor who paused it (from the manifest). Reported, does NOT fire.
 *
 * Pure and clock-injected so it can back a /health enrichment, a Sentry
 * monitor, or a Cloud Monitoring alert without a DB or wall-clock dependency.
 *
 * Constitution §1.5: findings state what is measured (silence + codified
 * attribution), never an asserted prod cause.
 */

import type { ScheduledJobSpec } from './scheduler-manifest.js';

/** Conservative default overdue window when a job omits maxSilenceMs. */
export const DEFAULT_MAX_SILENCE_MS = 3 * 60 * 60 * 1000; // 3h

/**
 * Tolerance for a last-run timestamp that is slightly in the future (benign NTP
 * skew between the worker that stamped it and the evaluator). Beyond this, a
 * future timestamp is invalid telemetry — the dead-man must fail loud rather
 * than treat a negative "silence" as healthy forever (review P1).
 */
export const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000; // 1 min

export interface JobRunSignal {
  id: string;
  /** ISO timestamp of the last SUCCESSFUL run, or null if never run. */
  lastRunAt: string | null;
}

export type StallAttribution = 'paused' | 'unattributed' | 'healthy';

export interface SchedulerDeadmanFinding {
  jobId: string;
  attribution: StallAttribution;
  /** The actor responsible when attribution==='paused'; null otherwise. */
  actor: string | null;
  /** True only for enabled+overdue/silent jobs (the paging condition). */
  firing: boolean;
  /** Silence in ms when measurable; null when the job never ran / no signal. */
  silenceMs: number | null;
  message: string;
}

export interface SchedulerDeadmanReport {
  firing: boolean;
  firingJobIds: string[];
  findings: SchedulerDeadmanFinding[];
}

function silenceMsFrom(lastRunAt: string | null, nowMs: number): number | null {
  if (!lastRunAt) return null;
  const t = Date.parse(lastRunAt);
  if (Number.isNaN(t)) return null;
  return nowMs - t;
}

/**
 * Evaluate the scheduler dead-man over the monitored fleet.
 *
 * @param manifest monitored jobs (the critical set from scheduler-manifest.ts)
 * @param signals  per-job last-run telemetry (may be missing entries)
 * @param nowMs    injected wall clock
 */
export function evaluateSchedulerDeadman(
  manifest: ScheduledJobSpec[],
  signals: JobRunSignal[],
  nowMs: number,
): SchedulerDeadmanReport {
  const signalById = new Map(signals.map((s) => [s.id, s]));
  const findings: SchedulerDeadmanFinding[] = [];

  for (const job of manifest) {
    const signal = signalById.get(job.id);
    const silenceMs = signal ? silenceMsFrom(signal.lastRunAt, nowMs) : null;

    // Paused job: silence is expected. Attribute it to the actor and move on.
    if (!job.enabled) {
      findings.push({
        jobId: job.id,
        attribution: 'paused',
        actor: job.pausedBy ?? null,
        firing: false,
        silenceMs,
        message:
          `${job.id} is PAUSED by ${job.pausedBy ?? 'unknown'} ` +
          `(${job.pausedReason ?? 'no reason recorded'}, since ${job.pausedAt ?? 'unknown date'}) — expected silence.`,
      });
      continue;
    }

    const maxSilence = job.maxSilenceMs ?? DEFAULT_MAX_SILENCE_MS;

    // Enabled but no telemetry at all → cannot prove it is running → fail loud.
    if (!signal) {
      findings.push({
        jobId: job.id,
        attribution: 'unattributed',
        actor: null,
        firing: true,
        silenceMs: null,
        message: `${job.id} is ENABLED but has no run signal at all — cannot confirm it is running. Unattributed stall; page a human.`,
      });
      continue;
    }

    // Enabled, never ran / unparseable timestamp, and past the window →
    // unattributed stall.
    if (silenceMs === null) {
      findings.push({
        jobId: job.id,
        attribution: 'unattributed',
        actor: null,
        firing: true,
        silenceMs: null,
        message: `${job.id} is ENABLED but has never run (or its last-run timestamp is unparseable) — unattributed stall; page a human.`,
      });
      continue;
    }

    // Future timestamp beyond benign clock skew → invalid telemetry. A negative
    // "silence" must NOT be classified healthy indefinitely (review P1): fail loud.
    if (silenceMs < -CLOCK_SKEW_TOLERANCE_MS) {
      findings.push({
        jobId: job.id,
        attribution: 'unattributed',
        actor: null,
        firing: true,
        silenceMs,
        message:
          `${job.id} is ENABLED but its last-run timestamp is ${Math.round(-silenceMs / 60000)}m ` +
          `in the FUTURE (> ${Math.round(CLOCK_SKEW_TOLERANCE_MS / 1000)}s skew tolerance) — invalid telemetry; page a human.`,
      });
      continue;
    }

    // Enabled and overdue → unattributed stall (nobody owns this silence).
    if (silenceMs > maxSilence) {
      findings.push({
        jobId: job.id,
        attribution: 'unattributed',
        actor: null,
        firing: true,
        silenceMs,
        message:
          `${job.id} is ENABLED but silent for ${Math.round(silenceMs / 60000)}m ` +
          `(> ${Math.round(maxSilence / 60000)}m budget) with no codified pause — unattributed stall; page a human.`,
      });
      continue;
    }

    // Enabled and healthy → nothing worth reporting (findings carry only
    // paused-attribution and firing stalls).
  }

  const firingJobIds = findings.filter((f) => f.firing).map((f) => f.jobId);
  return {
    firing: firingJobIds.length > 0,
    firingJobIds,
    findings,
  };
}
