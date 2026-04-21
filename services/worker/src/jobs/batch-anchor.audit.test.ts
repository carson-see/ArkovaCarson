/**
 * ARK-102 (SCRUM-1012) — Dynamic Merkle Batching Engine audit tests.
 *
 * Pins the behavior of Trigger A (size), Trigger B (age), and Trigger C
 * (fee ceiling) so refactors can't silently change the semantics. Also
 * pins the hard constants (BATCH_SIZE, MIN_BATCH_THRESHOLD, MAX_ANCHOR_AGE_MS,
 * ABSOLUTE_FEE_CAP_SAT_PER_VB) that the rest of the platform relies on.
 *
 * Spec (from docs/design/compliance-intelligence-epic.md §9):
 *   Trigger A — size-based, fires when pending claimed count == BATCH_SIZE
 *   Trigger B — age-based, forces fire when oldest pending ≥ MAX_ANCHOR_AGE_MS
 *   Trigger C — fee-aware, defers when currentFee > dynamic ceiling,
 *               ceiling scales 1×/2×/4× by backlog age, capped at ABSOLUTE cap.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock config/db/logger/chain so importing the SUT doesn't trip loadConfig().
vi.mock('../config.js', () => ({ config: { maxFeeThresholdSatPerVbyte: 50 } }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/db.js', () => ({
  db: { from: vi.fn(), rpc: vi.fn() },
  withDbTimeout: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../chain/client.js', () => ({ getChainClient: vi.fn() }));

const {
  BATCH_SIZE,
  MIN_BATCH_SIZE,
  MIN_BATCH_THRESHOLD,
  MAX_ANCHOR_AGE_MS,
  ABSOLUTE_FEE_CAP_SAT_PER_VB,
  triggerA_shouldFireOnSize,
  triggerB_shouldFireOnAge,
  triggerC_computeFeeCeiling,
} = await import('./batch-anchor.js');

describe('ARK-102 constants — do not change without design review', () => {
  it('BATCH_SIZE is pinned to 10,000', () => {
    expect(BATCH_SIZE).toBe(10_000);
  });

  it('MIN_BATCH_SIZE is pinned to 1', () => {
    expect(MIN_BATCH_SIZE).toBe(1);
  });

  it('MIN_BATCH_THRESHOLD is pinned to 5', () => {
    expect(MIN_BATCH_THRESHOLD).toBe(5);
  });

  it('MAX_ANCHOR_AGE_MS is pinned to 10 minutes', () => {
    expect(MAX_ANCHOR_AGE_MS).toBe(10 * 60 * 1000);
  });

  it('ABSOLUTE_FEE_CAP_SAT_PER_VB is pinned to 200', () => {
    expect(ABSOLUTE_FEE_CAP_SAT_PER_VB).toBe(200);
  });
});

describe('Trigger A — size-based fire', () => {
  it('fires at exactly BATCH_SIZE', () => {
    expect(triggerA_shouldFireOnSize(BATCH_SIZE)).toBe(true);
  });

  it('does NOT fire at BATCH_SIZE - 1', () => {
    expect(triggerA_shouldFireOnSize(BATCH_SIZE - 1)).toBe(false);
  });

  it('does NOT fire at 0', () => {
    expect(triggerA_shouldFireOnSize(0)).toBe(false);
  });

  it('fires for arbitrarily large counts', () => {
    expect(triggerA_shouldFireOnSize(BATCH_SIZE * 100)).toBe(true);
  });
});

describe('Trigger B — age-based fire', () => {
  it('never fires with pending count of 0', () => {
    expect(
      triggerB_shouldFireOnAge({ pendingCount: 0, oldestPendingAgeMs: Number.MAX_SAFE_INTEGER }),
    ).toBe(false);
  });

  it('fires once pending reaches MIN_BATCH_THRESHOLD regardless of age', () => {
    expect(
      triggerB_shouldFireOnAge({ pendingCount: MIN_BATCH_THRESHOLD, oldestPendingAgeMs: 0 }),
    ).toBe(true);
  });

  it('does NOT fire below threshold when oldest is fresh', () => {
    expect(
      triggerB_shouldFireOnAge({
        pendingCount: MIN_BATCH_THRESHOLD - 1,
        oldestPendingAgeMs: MAX_ANCHOR_AGE_MS - 1,
      }),
    ).toBe(false);
  });

  it('forces fire at or past MAX_ANCHOR_AGE_MS even with 1 pending', () => {
    expect(
      triggerB_shouldFireOnAge({ pendingCount: 1, oldestPendingAgeMs: MAX_ANCHOR_AGE_MS }),
    ).toBe(true);
    expect(
      triggerB_shouldFireOnAge({ pendingCount: 1, oldestPendingAgeMs: MAX_ANCHOR_AGE_MS + 1 }),
    ).toBe(true);
  });

  it('boundary — pending at MIN_BATCH_THRESHOLD - 1, age one ms below threshold → false', () => {
    expect(
      triggerB_shouldFireOnAge({
        pendingCount: MIN_BATCH_THRESHOLD - 1,
        oldestPendingAgeMs: MAX_ANCHOR_AGE_MS - 1,
      }),
    ).toBe(false);
  });
});

describe('Trigger C — dynamic fee ceiling', () => {
  const MIN = 60_000;

  it('returns base ceiling when backlog is fresh', () => {
    expect(
      triggerC_computeFeeCeiling({ baseCeiling: 50, oldestPendingAgeMs: 0 }),
    ).toBe(50);
  });

  it('doubles ceiling when oldest exceeds 30 minutes', () => {
    expect(
      triggerC_computeFeeCeiling({ baseCeiling: 50, oldestPendingAgeMs: 30 * MIN + 1 }),
    ).toBe(100);
  });

  it('quadruples ceiling when oldest exceeds 1 hour', () => {
    expect(
      triggerC_computeFeeCeiling({ baseCeiling: 50, oldestPendingAgeMs: 60 * MIN + 1 }),
    ).toBe(200);
  });

  it('caps ceiling at ABSOLUTE_FEE_CAP_SAT_PER_VB even with extreme base', () => {
    expect(
      triggerC_computeFeeCeiling({ baseCeiling: 300, oldestPendingAgeMs: 60 * MIN + 1 }),
    ).toBe(ABSOLUTE_FEE_CAP_SAT_PER_VB);
    // base already above cap with fresh backlog — still capped
    expect(
      triggerC_computeFeeCeiling({ baseCeiling: 500, oldestPendingAgeMs: 0 }),
    ).toBe(ABSOLUTE_FEE_CAP_SAT_PER_VB);
  });

  it('boundary — exactly 30 minutes does NOT trigger 2× escalation', () => {
    expect(
      triggerC_computeFeeCeiling({ baseCeiling: 50, oldestPendingAgeMs: 30 * MIN }),
    ).toBe(50);
  });

  it('boundary — exactly 60 minutes keeps 2× not 4×', () => {
    expect(
      triggerC_computeFeeCeiling({ baseCeiling: 50, oldestPendingAgeMs: 60 * MIN }),
    ).toBe(100);
  });
});

describe('Cross-trigger invariants', () => {
  it('MIN_BATCH_SIZE ≤ MIN_BATCH_THRESHOLD ≤ BATCH_SIZE', () => {
    expect(MIN_BATCH_SIZE).toBeLessThanOrEqual(MIN_BATCH_THRESHOLD);
    expect(MIN_BATCH_THRESHOLD).toBeLessThanOrEqual(BATCH_SIZE);
  });

  it('at fresh age + threshold met, Trigger B fires and Trigger A may not', () => {
    // This is the steady-state "normal throughput" path — Trigger A waits
    // until we have 10K; Trigger B will ship earlier if we accumulate ≥5
    // with a fresh backlog.
    expect(triggerA_shouldFireOnSize(MIN_BATCH_THRESHOLD)).toBe(false);
    expect(
      triggerB_shouldFireOnAge({ pendingCount: MIN_BATCH_THRESHOLD, oldestPendingAgeMs: 0 }),
    ).toBe(true);
  });

  it('fee ceiling is never negative', () => {
    expect(
      triggerC_computeFeeCeiling({ baseCeiling: 0, oldestPendingAgeMs: 0 }),
    ).toBe(0);
  });
});
