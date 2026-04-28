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

  it('MIN_BATCH_THRESHOLD is pinned to 3,000 (size floor for economic UTXO + fee)', () => {
    expect(MIN_BATCH_THRESHOLD).toBe(3_000);
  });

  it('MAX_ANCHOR_AGE_MS is pinned to 3 hours (age ceiling on PENDING)', () => {
    expect(MAX_ANCHOR_AGE_MS).toBe(3 * 60 * 60 * 1000);
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

describe('Trigger B — age-based fire (gated by MIN_BATCH_THRESHOLD)', () => {
  it('never fires with pending count of 0', () => {
    expect(
      triggerB_shouldFireOnAge({ pendingCount: 0, oldestPendingAgeMs: Number.MAX_SAFE_INTEGER }),
    ).toBe(false);
  });

  it('does NOT fire below MIN_BATCH_THRESHOLD even at 3-hour age (Codex finding on PR #627)', () => {
    // The 3-hour clock only runs ONCE the queue has crossed 3,000.
    // A 1-anchor or 100-anchor stale backlog must NOT fire — the daily
    // 3am EST `force` sweep handles long-tail micro-queues. Otherwise
    // we'd burn a UTXO on a single-leaf Merkle tree.
    expect(
      triggerB_shouldFireOnAge({ pendingCount: 1, oldestPendingAgeMs: MAX_ANCHOR_AGE_MS }),
    ).toBe(false);
    expect(
      triggerB_shouldFireOnAge({ pendingCount: 1, oldestPendingAgeMs: MAX_ANCHOR_AGE_MS * 10 }),
    ).toBe(false);
    expect(
      triggerB_shouldFireOnAge({
        pendingCount: MIN_BATCH_THRESHOLD - 1,
        oldestPendingAgeMs: MAX_ANCHOR_AGE_MS,
      }),
    ).toBe(false);
  });

  it('does NOT fire at MIN_BATCH_THRESHOLD when age is fresh — clock just started', () => {
    // Operator rule: hitting 3,000 starts the clock; doesn't fire the TX.
    expect(
      triggerB_shouldFireOnAge({ pendingCount: MIN_BATCH_THRESHOLD, oldestPendingAgeMs: 0 }),
    ).toBe(false);
  });

  it('FIRES at MIN_BATCH_THRESHOLD once age ≥ MAX_ANCHOR_AGE_MS', () => {
    // 3,000 pending + 3 hours = fire. Even if queue hasn't grown to 10k,
    // the age guarantee means the oldest leaf has been PENDING long
    // enough that we ship whatever's claimed.
    expect(
      triggerB_shouldFireOnAge({
        pendingCount: MIN_BATCH_THRESHOLD,
        oldestPendingAgeMs: MAX_ANCHOR_AGE_MS,
      }),
    ).toBe(true);
  });

  it("FIRES at the operator's canonical example: 4,500 pending at 3 hours", () => {
    // From the rule the user stated: "if after 3 hours theres only 4500
    // anchors ready, event is still triggered."
    expect(
      triggerB_shouldFireOnAge({ pendingCount: 4_500, oldestPendingAgeMs: MAX_ANCHOR_AGE_MS }),
    ).toBe(true);
    expect(
      triggerB_shouldFireOnAge({ pendingCount: 4_500, oldestPendingAgeMs: MAX_ANCHOR_AGE_MS + 1 }),
    ).toBe(true);
  });

  it('does NOT fire at-or-above threshold when age < MAX_ANCHOR_AGE_MS', () => {
    // 8,000 pending at 2 hours: keeps waiting (Trigger A handles 10k cap).
    expect(
      triggerB_shouldFireOnAge({
        pendingCount: 8_000,
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

  // CIBA-HARDEN-06: pin the below-threshold case (29 min still in fresh tier).
  it('stays at base ceiling for ages below the 30-minute threshold', () => {
    expect(
      triggerC_computeFeeCeiling({ baseCeiling: 50, oldestPendingAgeMs: 29 * MIN }),
    ).toBe(50);
  });

  it('doubles ceiling when oldest exceeds 30 minutes', () => {
    expect(
      triggerC_computeFeeCeiling({ baseCeiling: 50, oldestPendingAgeMs: 30 * MIN + 1 }),
    ).toBe(100);
  });

  // CIBA-HARDEN-06: pin the mid-band case (45 min still in 2x tier, before 1h).
  it('stays at 2x for ages in the 30-60 minute band', () => {
    expect(
      triggerC_computeFeeCeiling({ baseCeiling: 50, oldestPendingAgeMs: 45 * MIN }),
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

  it('at fresh age + threshold met, NEITHER Trigger A nor Trigger B fires (size alone is not a fire condition)', () => {
    // Operator rule: hitting MIN_BATCH_THRESHOLD starts the 3-hour clock
    // but does NOT fire a TX. Trigger A waits for BATCH_SIZE; Trigger B
    // waits for MAX_ANCHOR_AGE_MS. Either condition independently fires.
    expect(triggerA_shouldFireOnSize(MIN_BATCH_THRESHOLD)).toBe(false);
    expect(
      triggerB_shouldFireOnAge({ pendingCount: MIN_BATCH_THRESHOLD, oldestPendingAgeMs: 0 }),
    ).toBe(false);
  });

  it('sub-threshold stale backlog stays parked — daily force flush is the only out', () => {
    // 100 anchors sitting for 12 hours: neither A nor B fires. The
    // `daily-anchor-flush` cron at 3am EST passes opts.force=true to
    // bypass triggers and drain whatever's queued. Pinned so future
    // refactors can't reintroduce "fire on age alone" without breaking
    // this test.
    expect(triggerA_shouldFireOnSize(100)).toBe(false);
    expect(
      triggerB_shouldFireOnAge({ pendingCount: 100, oldestPendingAgeMs: 12 * 60 * 60 * 1000 }),
    ).toBe(false);
  });

  it('fee ceiling is never negative', () => {
    expect(
      triggerC_computeFeeCeiling({ baseCeiling: 0, oldestPendingAgeMs: 0 }),
    ).toBe(0);
  });
});
