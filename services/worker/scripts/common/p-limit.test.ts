import { describe, expect, it } from 'vitest';
import { pLimit } from './p-limit';

describe('pLimit', () => {
  it('rejects non-positive concurrency', () => {
    expect(() => pLimit(0)).toThrow(/concurrency/);
    expect(() => pLimit(-1)).toThrow(/concurrency/);
  });

  it('runs all tasks and returns results in map order', async () => {
    const limit = pLimit(3);
    const out = await Promise.all([1, 2, 3, 4, 5].map((n) => limit(async () => n * 2)));
    expect(out).toEqual([2, 4, 6, 8, 10]);
  });

  it('never exceeds the concurrency cap', async () => {
    const limit = pLimit(2);
    let inFlight = 0;
    let peak = 0;
    const tick = () => new Promise((r) => setTimeout(r, 5));
    await Promise.all(
      Array.from({ length: 10 }, () =>
        limit(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await tick();
          inFlight--;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('propagates rejection without deadlocking the queue', async () => {
    const limit = pLimit(2);
    const results = await Promise.allSettled([
      limit(async () => {
        throw new Error('boom');
      }),
      limit(async () => 'ok'),
      limit(async () => 'also-ok'),
    ]);
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');
    expect(results[2].status).toBe('fulfilled');
  });
});
