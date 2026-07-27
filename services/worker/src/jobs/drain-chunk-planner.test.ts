/**
 * Tests for the chunked-drain planner (SCRUM-2900 / BUG-008).
 *
 * The nightly drain must clear a large PENDING backlog in BOUNDED chunks — the
 * fee/credit model caps each broadcast batch (~10k anchors/tx). BUG-008: an
 * unbounded single-pass drain over a very large backlog is unsafe (oversized
 * tx / memory). SCRUM-2620 repro (absorbed here as a failing-first test): at
 * chunk boundaries the naive planner must not DROP or DOUBLE-PROCESS items —
 * coverage must be exact.
 */

import { describe, it, expect } from 'vitest';
import { planDrainChunks, DEFAULT_MAX_CHUNK } from './drain-chunk-planner.js';

describe('planDrainChunks (SCRUM-2900 / BUG-008)', () => {
  it('an empty backlog yields zero passes', () => {
    const plan = planDrainChunks(0, 10_000);
    expect(plan.passes).toBe(0);
    expect(plan.chunks).toEqual([]);
    expect(plan.totalCovered).toBe(0);
  });

  it('a backlog within one chunk yields a single pass', () => {
    const plan = planDrainChunks(4_200, 10_000);
    expect(plan.passes).toBe(1);
    expect(plan.chunks).toEqual([4_200]);
    expect(plan.totalCovered).toBe(4_200);
  });

  it('a backlog exactly on the boundary yields a single full chunk', () => {
    const plan = planDrainChunks(10_000, 10_000);
    expect(plan.passes).toBe(1);
    expect(plan.chunks).toEqual([10_000]);
  });

  // SCRUM-2620 repro: the real 261,934 backlog with the ~10k/tx cap MUST split.
  it('splits the real ~261,934 backlog into bounded 10k chunks (SCRUM-2620 repro)', () => {
    const backlog = 261_934;
    const cap = 10_000;
    const plan = planDrainChunks(backlog, cap);

    // Not a single unbounded pass.
    expect(plan.passes).toBe(Math.ceil(backlog / cap)); // 27
    // No chunk exceeds the per-tx cap (BUG-008).
    expect(Math.max(...plan.chunks)).toBeLessThanOrEqual(cap);
    // Coverage is EXACT — no dropped or double-processed items at boundaries.
    expect(plan.totalCovered).toBe(backlog);
    expect(plan.chunks.reduce((a, b) => a + b, 0)).toBe(backlog);
    // The remainder lands in the final chunk.
    expect(plan.chunks[plan.chunks.length - 1]).toBe(backlog % cap); // 1934
    // No zero-sized chunk.
    expect(plan.chunks.every((c) => c > 0)).toBe(true);
  });

  it('coverage invariant holds across many sizes and caps (property sweep)', () => {
    for (const n of [1, 9_999, 10_001, 20_000, 55_555, 100_000]) {
      for (const cap of [500, 1_000, 10_000]) {
        const plan = planDrainChunks(n, cap);
        expect(plan.totalCovered, `n=${n} cap=${cap}`).toBe(n);
        expect(plan.chunks.reduce((a, b) => a + b, 0)).toBe(n);
        expect(Math.max(...plan.chunks)).toBeLessThanOrEqual(cap);
        expect(plan.chunks.every((c) => c > 0)).toBe(true);
        expect(plan.passes).toBe(Math.ceil(n / cap));
      }
    }
  });

  it('rejects a non-positive or non-integer chunk cap (fail loud, not silent)', () => {
    expect(() => planDrainChunks(100, 0)).toThrow();
    expect(() => planDrainChunks(100, -5)).toThrow();
    expect(() => planDrainChunks(100, 3.5)).toThrow();
  });

  it('rejects a negative or non-integer backlog', () => {
    expect(() => planDrainChunks(-1, 10)).toThrow();
    expect(() => planDrainChunks(2.5, 10)).toThrow();
  });

  it('defaults the cap to DEFAULT_MAX_CHUNK when not supplied', () => {
    const plan = planDrainChunks(DEFAULT_MAX_CHUNK + 1);
    expect(plan.passes).toBe(2);
    expect(plan.chunks[0]).toBe(DEFAULT_MAX_CHUNK);
    expect(plan.chunks[1]).toBe(1);
  });
});
