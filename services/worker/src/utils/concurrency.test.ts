/**
 * Tests for runWithConcurrency (SCRUM-1264 R2-1).
 */

import { describe, it, expect } from 'vitest';
import { runWithConcurrency } from './concurrency.js';

describe('runWithConcurrency', () => {
  it('runs all tasks and collects fulfilled values', async () => {
    const tasks = [1, 2, 3, 4, 5].map((n) => async () => n * 2);
    const result = await runWithConcurrency(tasks, 2);
    expect(result.fulfilled.sort((a, b) => a - b)).toEqual([2, 4, 6, 8, 10]);
    expect(result.rejected).toEqual([]);
  });

  it('caps in-flight tasks at the concurrency limit', async () => {
    let inFlight = 0;
    let maxObserved = 0;
    const tasks = Array.from({ length: 50 }, () => async () => {
      inFlight++;
      if (inFlight > maxObserved) maxObserved = inFlight;
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return inFlight;
    });

    const concurrency = 5;
    await runWithConcurrency(tasks, concurrency);

    expect(maxObserved).toBeLessThanOrEqual(concurrency);
  });

  it('captures rejections per index without throwing', async () => {
    const tasks: Array<() => Promise<number>> = [
      async () => 1,
      async () => { throw new Error('boom'); },
      async () => 3,
    ];
    const result = await runWithConcurrency(tasks, 2);
    expect(result.fulfilled.sort((a, b) => a - b)).toEqual([1, 3]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].index).toBe(1);
    expect(result.rejected[0].reason).toBeInstanceOf(Error);
  });

  it('handles an empty task list', async () => {
    const result = await runWithConcurrency([], 5);
    expect(result.fulfilled).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it('throws synchronously on invalid concurrency', async () => {
    await expect(runWithConcurrency([async () => 1], 0)).rejects.toThrow(/concurrency must be a positive integer/);
    await expect(runWithConcurrency([async () => 1], -1)).rejects.toThrow(/concurrency must be a positive integer/);
  });

  // PR #567 CodeRabbit minor fix: NaN / Infinity / non-integer values would
  // otherwise fall through to Math.min(NaN, n) = NaN → zero workers → silent
  // task drop. Lock the throw path so a future caller mistake fails loud.
  it('PR #567 fix: throws on NaN / Infinity / non-integer concurrency', async () => {
    await expect(runWithConcurrency([async () => 1], NaN)).rejects.toThrow(/concurrency must be a positive integer/);
    await expect(runWithConcurrency([async () => 1], 2.5)).rejects.toThrow(/concurrency must be a positive integer/);
    await expect(runWithConcurrency([async () => 1], Infinity)).rejects.toThrow(/concurrency must be a positive integer/);
  });
});
