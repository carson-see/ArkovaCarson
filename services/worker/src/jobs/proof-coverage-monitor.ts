/**
 * Proof-coverage regression monitor (SCRUM-3187).
 *
 * Arkova promises offline, forever verification of any secured document. That
 * promise is only kept if every newly SECURED anchor gets a per-document
 * inclusion proof. This monitor is the standing alarm on that invariant.
 *
 * ── Scope: the FORWARD path only ─────────────────────────────────────────────
 * It measures coverage over a recent window, NOT lifetime coverage. The ~2.97M
 * historical anchors with no proof are a known, separately-tracked backlog
 * (see docs/runbooks/ops/proof-coverage-backfill.md); folding them in would
 * hold the alarm permanently red, and a permanently red alarm is an alarm
 * nobody reads. A regression on new anchors is the thing that must page.
 *
 * ── Shape ────────────────────────────────────────────────────────────────────
 * `evaluateProofCoverage` is pure and total over its input so the alerting
 * rules are unit-testable with no database and no clock; `runProofCoverageCheck`
 * is the thin cron glue. Same convention as stuck-anchor-monitor.ts.
 *
 * Constitution refs: §1.5 (report what is measured, not what is assumed).
 */

/** Below this fraction of the window covered, the monitor fires. */
export const DEFAULT_MIN_COVERAGE_RATIO = 0.99;

/**
 * Minimum anchors in the window before a ratio means anything. A single missed
 * anchor out of three is noise, not a regression.
 */
export const DEFAULT_MIN_SAMPLE = 20;

/** Below this fraction, the regression is treated as an outage, not a dip. */
const SEVERE_COVERAGE_RATIO = 0.9;

export interface ProofCoverageInput {
  windowHours: number;
  /** SECURED, non-deleted anchors created in the window. */
  securedInWindow: number;
  /** How many of those have an anchor_proofs row. */
  proofsInWindow: number;
  minCoverageRatio?: number;
  minSampleSize?: number;
}

export type ProofCoverageReason =
  | 'healthy'
  | 'no_anchors_in_window'
  | 'insufficient_sample'
  | 'coverage_below_threshold';

export interface ProofCoverageDecision {
  shouldFire: boolean;
  severity: 'warning' | 'error';
  /** Clamped to [0,1]; 1 when there is nothing to cover. */
  coverageRatio: number;
  /** Anchors in the window with no proof row (never negative). */
  missingCount: number;
  reason: ProofCoverageReason;
  windowHours: number;
  securedInWindow: number;
  proofsInWindow: number;
}

export function evaluateProofCoverage(input: ProofCoverageInput): ProofCoverageDecision {
  const minRatio = input.minCoverageRatio ?? DEFAULT_MIN_COVERAGE_RATIO;
  const minSample = input.minSampleSize ?? DEFAULT_MIN_SAMPLE;
  const secured = Math.max(0, input.securedInWindow);
  const proofs = Math.max(0, input.proofsInWindow);

  // A proof count above the anchor count is a transient mid-write read, not a
  // negative deficit — clamp rather than report a nonsensical ratio.
  const coverageRatio = secured === 0 ? 1 : Math.min(1, proofs / secured);
  const missingCount = Math.max(0, secured - proofs);

  const shared = {
    coverageRatio,
    missingCount,
    windowHours: input.windowHours,
    securedInWindow: secured,
    proofsInWindow: proofs,
  };

  if (secured === 0) {
    return { shouldFire: false, severity: 'warning', reason: 'no_anchors_in_window', ...shared };
  }
  if (secured < minSample) {
    return { shouldFire: false, severity: 'warning', reason: 'insufficient_sample', ...shared };
  }
  if (coverageRatio >= minRatio) {
    return { shouldFire: false, severity: 'warning', reason: 'healthy', ...shared };
  }
  return {
    shouldFire: true,
    severity: coverageRatio < SEVERE_COVERAGE_RATIO ? 'error' : 'warning',
    reason: 'coverage_below_threshold',
    ...shared,
  };
}

// ── Cron glue ────────────────────────────────────────────────────────────────

export interface ProofCoverageDeps {
  /** Reads the window counts (RPC `proof_coverage_window`). */
  fetchWindowCoverage: (windowHours: number) => Promise<{ secured: number; withProof: number }>;
  alert: (message: string, extra: Record<string, unknown>, severity: 'warning' | 'error') => void;
  logger: { info: (o: object, m: string) => void; error: (o: object, m: string) => void };
}

export interface ProofCoverageRunResult {
  healthy: boolean;
  decision: ProofCoverageDecision;
}

export async function runProofCoverageCheck(
  deps: ProofCoverageDeps,
  options: { windowHours?: number; minCoverageRatio?: number } = {},
): Promise<ProofCoverageRunResult> {
  const windowHours = options.windowHours ?? 24;
  const { secured, withProof } = await deps.fetchWindowCoverage(windowHours);

  const decision = evaluateProofCoverage({
    windowHours,
    securedInWindow: secured,
    proofsInWindow: withProof,
    minCoverageRatio: options.minCoverageRatio,
  });

  if (decision.shouldFire) {
    deps.alert(
      `Proof coverage regression: ${decision.missingCount} of ${decision.securedInWindow} anchors secured in the last ${windowHours}h have no per-document proof`,
      {
        coverage_ratio: Number(decision.coverageRatio.toFixed(4)),
        missing_count: decision.missingCount,
        secured_in_window: decision.securedInWindow,
        proofs_in_window: decision.proofsInWindow,
        window_hours: windowHours,
      },
      decision.severity,
    );
    deps.logger.error({ decision }, 'proof-coverage-monitor: forward-path coverage regression');
  } else {
    deps.logger.info({ decision }, 'proof-coverage-monitor: forward-path coverage checked');
  }

  return { healthy: !decision.shouldFire, decision };
}
