/**
 * SCRUM-2592 — batch fee-ceiling PARITY guarantee.
 *
 * The fee-estimator primitive `computeBatchFeeCeiling` MUST produce byte-identical
 * output to the batch-anchor source-of-truth `triggerC_computeFeeCeiling` when the
 * absolute cap it is fed equals batch-anchor's `ABSOLUTE_FEE_CAP_SAT_PER_VB`. This
 * is the anti-divergence contract from the ceremony premortem: the estimator
 * mirrors — never redefines — the batch-anchor fee model, so wiring the primitive
 * into batch-anchor after #1417 merges introduces no second, conflicting fee
 * curve.
 *
 * The locked `triggerC_computeFeeCeiling` + `ABSOLUTE_FEE_CAP_SAT_PER_VB` are
 * imported READ-ONLY (zero edit to batch-anchor.ts). The estimator side is the
 * only thing this PR authors.
 *
 * Per Constitution 1.7: no real chain/db calls — config/db/logger/chain are
 * mocked so importing the SUT does not trip loadConfig().
 */

import { describe, it, expect, vi } from 'vitest';

// Mock config/db/logger/chain so importing batch-anchor.ts doesn't trip loadConfig().
vi.mock('../config.js', () => ({ config: { maxFeeThresholdSatPerVbyte: 50 } }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/db.js', () => ({
  db: { from: vi.fn(), rpc: vi.fn() },
  withDbTimeout: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../chain/client.js', () => ({ getChainClient: vi.fn() }));

import { computeBatchFeeCeiling } from './fee-estimator.js';

// READ-ONLY import of the locked source-of-truth fee model.
const { triggerC_computeFeeCeiling, ABSOLUTE_FEE_CAP_SAT_PER_VB } = await import(
  '../jobs/batch-anchor.js'
);

describe('fee-ceiling parity — estimator primitive mirrors batch-anchor triggerC', () => {
  const MIN = 60_000;

  // Sweep a representative input space: base ceilings spanning below/at/above the
  // absolute cap, and ages spanning every escalation band + exact boundaries.
  const baseCeilings = [0, 1, 25, 50, 100, 199, 200, 201, 300, 500];
  const ages = [
    0,
    1,
    29 * MIN,
    30 * MIN, // exact 30-min boundary (no escalation)
    30 * MIN + 1,
    45 * MIN,
    60 * MIN, // exact 60-min boundary (still 2×)
    60 * MIN + 1,
    3 * 60 * MIN,
    24 * 60 * MIN,
  ];

  it('produces byte-identical output across the full swept input space', () => {
    for (const baseCeiling of baseCeilings) {
      for (const oldestPendingAgeMs of ages) {
        const mirror = computeBatchFeeCeiling({
          baseCeiling,
          oldestPendingAgeMs,
          absoluteCapSatPerVb: ABSOLUTE_FEE_CAP_SAT_PER_VB,
        });
        const truth = triggerC_computeFeeCeiling({ baseCeiling, oldestPendingAgeMs });
        expect(mirror, `baseCeiling=${baseCeiling} ageMs=${oldestPendingAgeMs}`).toBe(truth);
      }
    }
  });

  it('never exceeds the absolute cap for any swept input (defense in depth)', () => {
    for (const baseCeiling of baseCeilings) {
      for (const oldestPendingAgeMs of ages) {
        const mirror = computeBatchFeeCeiling({
          baseCeiling,
          oldestPendingAgeMs,
          absoluteCapSatPerVb: ABSOLUTE_FEE_CAP_SAT_PER_VB,
        });
        expect(mirror).toBeLessThanOrEqual(ABSOLUTE_FEE_CAP_SAT_PER_VB);
      }
    }
  });
});
