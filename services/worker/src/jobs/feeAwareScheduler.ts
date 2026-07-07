/**
 * Fee-Aware Transaction Scheduler (BTC-002)
 *
 * Schedules batch anchoring during low-fee periods.
 * Historical data shows Saturdays are ~47% cheaper than Tue/Wed.
 *
 * Logic:
 *   1. Check current fee rate via mempool.space API
 *   2. If below threshold → submit batch immediately
 *   3. If above threshold → queue and retry in 30 minutes
 *   4. Hard deadline: 24h — if fees haven't dropped, submit anyway
 *
 * Uses MAX_FEE_THRESHOLD_SAT_PER_VBYTE from config (default: 50).
 */

import { computeBatchFeeCeiling } from '../chain/fee-estimator.js';

/** Fee estimator interface (duplicated to avoid config import chain) */
export interface FeeEstimator {
  estimateFee(): Promise<number>;
  readonly name: string;
}

/** Default max fee threshold in sat/vByte */
const DEFAULT_MAX_FEE = 50;

/** Retry interval when fees are too high (30 minutes) */
export const FEE_RETRY_INTERVAL_MS = 30 * 60 * 1000;

/** Hard deadline for queued batches (24 hours) */
export const FEE_HARD_DEADLINE_MS = 24 * 60 * 60 * 1000;

export interface FeeCheckResult {
  currentFee: number;
  threshold: number;
  shouldSubmit: boolean;
  reason: 'below_threshold' | 'above_threshold' | 'deadline_exceeded' | 'fee_check_failed';
}

/**
 * Check whether the current fee environment allows batch submission.
 *
 * @param maxFeeThreshold - Maximum acceptable fee rate in sat/vByte
 * @param queuedSince - Timestamp (ms) when the batch was first queued, or null if not queued
 * @param estimator - Optional injected fee estimator (for testing)
 * @returns FeeCheckResult with recommendation
 */
export async function checkFeeConditions(
  maxFeeThreshold?: number,
  queuedSince?: number | null,
  estimator?: FeeEstimator,
): Promise<FeeCheckResult> {
  const threshold = maxFeeThreshold ?? DEFAULT_MAX_FEE;

  // Check hard deadline first
  if (queuedSince && Date.now() - queuedSince >= FEE_HARD_DEADLINE_MS) {
    return {
      currentFee: 0,
      threshold,
      shouldSubmit: true,
      reason: 'deadline_exceeded',
    };
  }

  try {
    let feeEstimator = estimator;
    if (!feeEstimator) {
      const { MempoolFeeEstimator } = await import('../chain/fee-estimator.js');
      feeEstimator = new MempoolFeeEstimator({ target: 'halfHour', timeoutMs: 5000 });
    }
    const currentFee = await feeEstimator.estimateFee();

    if (currentFee <= threshold) {
      return {
        currentFee,
        threshold,
        shouldSubmit: true,
        reason: 'below_threshold',
      };
    }

    return {
      currentFee,
      threshold,
      shouldSubmit: false,
      reason: 'above_threshold',
    };
  } catch {
    // If fee estimation fails, submit anyway (don't block anchoring)
    return {
      currentFee: 0,
      threshold,
      shouldSubmit: true,
      reason: 'fee_check_failed',
    };
  }
}

/**
 * SCRUM-2592: Input for the dynamic (age-scaled) fee-condition check.
 */
export interface DynamicFeeConditionsInput {
  /** Base ceiling in sat/vByte (the configured max fee threshold). */
  baseCeiling: number;
  /** Age of the oldest pending anchor in ms — scales the ceiling. */
  oldestPendingAgeMs: number;
  /**
   * Absolute hard cap in sat/vByte, INJECTED by the caller (batch-anchor's
   * ABSOLUTE_FEE_CAP_SAT_PER_VB at the wire-up site). Never redefined here.
   */
  absoluteCapSatPerVb: number;
  /** Timestamp (ms) when the batch was first queued, or null if not queued. */
  queuedSince?: number | null;
  /** Optional injected fee estimator (for testing). */
  estimator?: FeeEstimator;
}

/**
 * SCRUM-2592: Fee-condition check against a DYNAMIC, age-scaled ceiling.
 *
 * Unlike {@link checkFeeConditions} (flat threshold), this compares the live fee
 * rate against `computeBatchFeeCeiling(baseCeiling, oldestPendingAgeMs, cap)` —
 * so a stale backlog tolerates a higher fee, bounded by the injected absolute
 * cap. The deadline-exceeded and fail-open (fee_check_failed) semantics are
 * preserved unchanged. `threshold` in the result is the EFFECTIVE (age-scaled,
 * capped) ceiling that the fee was compared against.
 *
 * This is a MIRROR of batch-anchor's triggerC fee model at the scheduler layer;
 * batch-anchor.ts remains the single owner of the constant. Wire-up (replacing
 * the flat threshold in the batch path) is a post-#1417-merge integration
 * handoff — see the branch description.
 */
export async function checkDynamicFeeConditions(
  input: DynamicFeeConditionsInput,
): Promise<FeeCheckResult> {
  const threshold = computeBatchFeeCeiling({
    baseCeiling: input.baseCeiling,
    oldestPendingAgeMs: input.oldestPendingAgeMs,
    absoluteCapSatPerVb: input.absoluteCapSatPerVb,
  });

  // Hard deadline first — same precedence as checkFeeConditions.
  if (input.queuedSince && Date.now() - input.queuedSince >= FEE_HARD_DEADLINE_MS) {
    return {
      currentFee: 0,
      threshold,
      shouldSubmit: true,
      reason: 'deadline_exceeded',
    };
  }

  try {
    let feeEstimator = input.estimator;
    if (!feeEstimator) {
      const { MempoolFeeEstimator } = await import('../chain/fee-estimator.js');
      feeEstimator = new MempoolFeeEstimator({ target: 'halfHour', timeoutMs: 5000 });
    }
    const currentFee = await feeEstimator.estimateFee();

    if (currentFee <= threshold) {
      return {
        currentFee,
        threshold,
        shouldSubmit: true,
        reason: 'below_threshold',
      };
    }

    return {
      currentFee,
      threshold,
      shouldSubmit: false,
      reason: 'above_threshold',
    };
  } catch {
    // Fail open — never block anchoring on a fee-estimation failure.
    return {
      currentFee: 0,
      threshold,
      shouldSubmit: true,
      reason: 'fee_check_failed',
    };
  }
}
