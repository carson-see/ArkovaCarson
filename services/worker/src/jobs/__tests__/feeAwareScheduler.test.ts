/**
 * BTC-002: Fee-Aware Transaction Scheduler Tests
 */

import { describe, it, expect, vi } from 'vitest';

// checkDynamicFeeConditions statically imports the fee-estimator primitive,
// which transitively loads logger → config. Mock config/logger so the import
// does not trip loadConfig() in the test environment.
vi.mock('../../config.js', () => ({
  config: { maxFeeThresholdSatPerVbyte: 50 },
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  checkFeeConditions,
  checkDynamicFeeConditions,
  FEE_HARD_DEADLINE_MS,
  FEE_RETRY_INTERVAL_MS,
} from '../feeAwareScheduler.js';
import type { FeeEstimator } from '../feeAwareScheduler.js';

/** Create a mock fee estimator that returns a fixed rate */
function mockEstimator(rate: number): FeeEstimator {
  return { estimateFee: async () => rate, name: 'Mock' };
}

/** Create a mock fee estimator that throws */
function failingEstimator(): FeeEstimator {
  return {
    estimateFee: async () => { throw new Error('Network error'); },
    name: 'FailingMock',
  };
}

describe('BTC-002: checkFeeConditions', () => {
  it('submits when fee is below threshold', async () => {
    const result = await checkFeeConditions(50, null, mockEstimator(10));
    expect(result.shouldSubmit).toBe(true);
    expect(result.reason).toBe('below_threshold');
    expect(result.currentFee).toBe(10);
  });

  it('queues when fee is above threshold', async () => {
    const result = await checkFeeConditions(50, null, mockEstimator(80));
    expect(result.shouldSubmit).toBe(false);
    expect(result.reason).toBe('above_threshold');
    expect(result.currentFee).toBe(80);
  });

  it('submits when fee equals threshold', async () => {
    const result = await checkFeeConditions(50, null, mockEstimator(50));
    expect(result.shouldSubmit).toBe(true);
    expect(result.reason).toBe('below_threshold');
  });

  it('force submits when deadline exceeded despite high fees', async () => {
    const queuedSince = Date.now() - FEE_HARD_DEADLINE_MS - 1000;
    const result = await checkFeeConditions(50, queuedSince, mockEstimator(100));
    expect(result.shouldSubmit).toBe(true);
    expect(result.reason).toBe('deadline_exceeded');
  });

  it('does not force submit when under deadline', async () => {
    const queuedSince = Date.now() - (FEE_HARD_DEADLINE_MS / 2);
    const result = await checkFeeConditions(50, queuedSince, mockEstimator(100));
    expect(result.shouldSubmit).toBe(false);
    expect(result.reason).toBe('above_threshold');
  });

  it('submits on fee estimation failure (graceful degradation)', async () => {
    const result = await checkFeeConditions(50, null, failingEstimator());
    expect(result.shouldSubmit).toBe(true);
    expect(result.reason).toBe('fee_check_failed');
  });

  it('uses default threshold of 50 when not specified', async () => {
    const result = await checkFeeConditions(undefined, null, mockEstimator(40));
    expect(result.threshold).toBe(50);
    expect(result.shouldSubmit).toBe(true);
  });

  it('exports correct interval constants', () => {
    expect(FEE_RETRY_INTERVAL_MS).toBe(30 * 60 * 1000);
    expect(FEE_HARD_DEADLINE_MS).toBe(24 * 60 * 60 * 1000);
  });
});

// ─── SCRUM-2592: dynamic (age-scaled) fee-condition check ───────────────────
//
// checkDynamicFeeConditions replaces the flat threshold with an age-scaled
// ceiling (via computeBatchFeeCeiling), so a stale backlog tolerates a higher
// fee — bounded by the injected absolute cap — while preserving the
// deadline-exceeded and fail-open (fee_check_failed) semantics of
// checkFeeConditions. This mirrors batch-anchor's triggerC without redefining
// its constants.
describe('SCRUM-2592: checkDynamicFeeConditions', () => {
  const MIN = 60_000;
  const CAP = 200; // caller-injected absolute cap (mirrors ABSOLUTE_FEE_CAP_SAT_PER_VB)

  it('submits when fee is at/below the fresh-backlog base ceiling', async () => {
    const result = await checkDynamicFeeConditions({
      baseCeiling: 50,
      oldestPendingAgeMs: 0,
      absoluteCapSatPerVb: CAP,
      queuedSince: null,
      estimator: mockEstimator(50),
    });
    expect(result.shouldSubmit).toBe(true);
    expect(result.reason).toBe('below_threshold');
    expect(result.threshold).toBe(50);
    expect(result.currentFee).toBe(50);
  });

  it('queues when fee exceeds the fresh-backlog ceiling', async () => {
    const result = await checkDynamicFeeConditions({
      baseCeiling: 50,
      oldestPendingAgeMs: 0,
      absoluteCapSatPerVb: CAP,
      queuedSince: null,
      estimator: mockEstimator(80),
    });
    expect(result.shouldSubmit).toBe(false);
    expect(result.reason).toBe('above_threshold');
    expect(result.threshold).toBe(50);
  });

  it('tolerates a higher fee once the backlog ages past 30 minutes (2× ceiling)', async () => {
    // Fee 80 exceeds the 50 base but is under the 100 ceiling once aged > 30 min.
    const result = await checkDynamicFeeConditions({
      baseCeiling: 50,
      oldestPendingAgeMs: 31 * MIN,
      absoluteCapSatPerVb: CAP,
      queuedSince: null,
      estimator: mockEstimator(80),
    });
    expect(result.shouldSubmit).toBe(true);
    expect(result.reason).toBe('below_threshold');
    expect(result.threshold).toBe(100);
  });

  it('still queues a fee that exceeds even the age-scaled ceiling', async () => {
    const result = await checkDynamicFeeConditions({
      baseCeiling: 50,
      oldestPendingAgeMs: 31 * MIN,
      absoluteCapSatPerVb: CAP,
      queuedSince: null,
      estimator: mockEstimator(150), // > 100 (2× ceiling)
    });
    expect(result.shouldSubmit).toBe(false);
    expect(result.reason).toBe('above_threshold');
  });

  it('never lets the ceiling exceed the injected absolute cap', async () => {
    // 4× of 300 would be 1200 but is clamped to CAP=200; fee 199 submits.
    const result = await checkDynamicFeeConditions({
      baseCeiling: 300,
      oldestPendingAgeMs: 61 * MIN,
      absoluteCapSatPerVb: CAP,
      queuedSince: null,
      estimator: mockEstimator(199),
    });
    expect(result.threshold).toBe(CAP);
    expect(result.shouldSubmit).toBe(true);
  });

  it('force-submits when the hard deadline is exceeded regardless of fee', async () => {
    const queuedSince = Date.now() - FEE_HARD_DEADLINE_MS - 1000;
    const result = await checkDynamicFeeConditions({
      baseCeiling: 50,
      oldestPendingAgeMs: 0,
      absoluteCapSatPerVb: CAP,
      queuedSince,
      estimator: mockEstimator(1000),
    });
    expect(result.shouldSubmit).toBe(true);
    expect(result.reason).toBe('deadline_exceeded');
  });

  it('fails open (submits) when fee estimation throws', async () => {
    const result = await checkDynamicFeeConditions({
      baseCeiling: 50,
      oldestPendingAgeMs: 0,
      absoluteCapSatPerVb: CAP,
      queuedSince: null,
      estimator: failingEstimator(),
    });
    expect(result.shouldSubmit).toBe(true);
    expect(result.reason).toBe('fee_check_failed');
  });
});
