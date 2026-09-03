/**
 * scripts/staging/load-harness-evidence.ts — pure stats + evidence-file model
 * for scripts/staging/load-harness.ts.
 *
 * Split out (mirrors load-harness-env.ts) so evidence semantics — including
 * the SCRUM-3444 partial-evidence flush on SIGINT/SIGTERM — can be unit
 * tested without importing the harness entrypoint, which runs main() on load
 * and shells out for IAM tokens. NOTHING here touches the network or disk.
 */

export interface RequestOutcome {
  mode: string;
  endpoint: string;
  status: number;
  latencyMs: number;
  ok: boolean;
}

export interface RunStats {
  startedAt: number;
  outcomes: RequestOutcome[];
  byMode: Record<string, { ok: number; fail: number; latencyMs: number[]; byStatus: Record<number, number> }>;
  classifier: {
    completed: number;
    refused: number;
    lockRefused: number;
    writesAppliedNonZero: number;
    malformedBodies: number;
  };
}

export function newStats(): RunStats {
  return {
    startedAt: Date.now(),
    outcomes: [],
    byMode: {},
    classifier: {
      completed: 0,
      refused: 0,
      lockRefused: 0,
      writesAppliedNonZero: 0,
      malformedBodies: 0,
    },
  };
}

export function record(stats: RunStats, o: RequestOutcome): void {
  stats.outcomes.push(o);
  const slot = stats.byMode[o.mode] ?? { ok: 0, fail: 0, latencyMs: [], byStatus: {} };
  if (o.ok) slot.ok++;
  else slot.fail++;
  slot.latencyMs.push(o.latencyMs);
  slot.byStatus[o.status] = (slot.byStatus[o.status] ?? 0) + 1;
  stats.byMode[o.mode] = slot;
}

export function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

export interface EvidenceInterruption {
  /** The shutdown signal that ended the run early (e.g. SIGINT, SIGTERM). */
  signal: string;
  /** The full window the run was asked to cover, in seconds. */
  plannedDurationSec: number;
}

export interface EvidenceFile {
  startedAt: string;
  endedAt: string;
  durationSec: number;
  apiBase: string;
  mode: string;
  concurrency: number;
  totalRequests: number;
  byMode: Record<string, {
    ok: number;
    fail: number;
    errorRate: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    byStatus: Record<number, number>;
  }>;
  classifier?: RunStats['classifier'];
  /**
   * SCRUM-3444: the three fields below are present ONLY when the run was
   * interrupted (SIGINT/SIGTERM) before its planned window completed. A file
   * carrying `partial: true` is a salvage artifact covering durationSec of
   * the plannedDurationSec window — it must never be read as completed-soak
   * evidence. (check-staging-evidence.ts does not yet reject the marker;
   * that hardening is deferred until PR #2488 lands on the gate.)
   */
  partial?: true;
  interruptedBy?: string;
  plannedDurationSec?: number;
}

export function summarize(
  stats: RunStats,
  mode: string,
  concurrency: number,
  apiBase: string,
  interruption?: EvidenceInterruption,
): EvidenceFile {
  const startedAt = new Date(stats.startedAt).toISOString();
  const endedAt = new Date().toISOString();
  const durationSec = (Date.now() - stats.startedAt) / 1000;
  const byMode: EvidenceFile['byMode'] = {};
  for (const [m, slot] of Object.entries(stats.byMode)) {
    byMode[m] = {
      ok: slot.ok,
      fail: slot.fail,
      errorRate: slot.fail / Math.max(slot.ok + slot.fail, 1),
      p50Ms: percentile(slot.latencyMs, 50),
      p95Ms: percentile(slot.latencyMs, 95),
      p99Ms: percentile(slot.latencyMs, 99),
      byStatus: slot.byStatus,
    };
  }
  const evidence: EvidenceFile = {
    startedAt,
    endedAt,
    durationSec,
    apiBase,
    mode,
    concurrency,
    totalRequests: stats.outcomes.length,
    byMode,
    classifier: mode === 'classifier' ? stats.classifier : undefined,
  };
  if (interruption) {
    evidence.partial = true;
    evidence.interruptedBy = interruption.signal;
    evidence.plannedDurationSec = interruption.plannedDurationSec;
  }
  return evidence;
}

/**
 * Single-write evidence gate (SCRUM-3444). The first flush wins; every later
 * flush is a no-op that reports false. This guards both directions of the
 * interrupted-run race: a SIGINT/SIGTERM handler must not clobber the file a
 * completed run already wrote, and normal completion must not overwrite the
 * partial file a nearly-simultaneous signal flushed first.
 */
export function createEvidenceSink(
  write: (evidence: EvidenceFile) => void,
): (evidence: EvidenceFile) => boolean {
  let written = false;
  return (evidence: EvidenceFile): boolean => {
    if (written) return false;
    written = true;
    write(evidence);
    return true;
  };
}
