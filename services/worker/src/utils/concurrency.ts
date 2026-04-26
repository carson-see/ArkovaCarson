/**
 * Lightweight concurrency cap for fan-out work (SCRUM-1264 R2-1).
 *
 * Why not `p-limit`: avoiding a new dependency for what is ~30 lines of
 * straightforward queue-with-concurrency. The bulk-confirm webhook fan-out
 * needs a hard ceiling so 10K-anchor merkle batches don't issue 10K
 * concurrent fetches when a customer subscribes to `anchor.secured`.
 *
 * Contract:
 *   - At most `concurrency` tasks are in flight at any moment.
 *   - All tasks are scheduled in the order passed.
 *   - Errors propagate up via Promise.allSettled-style results — the runner
 *     never throws; callers inspect the returned array.
 */

export interface RunWithConcurrencyResult<T> {
  fulfilled: T[];
  rejected: { index: number; reason: unknown }[];
}

export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<RunWithConcurrencyResult<T>> {
  if (concurrency < 1) {
    throw new Error(`runWithConcurrency: concurrency must be >= 1 (got ${concurrency})`);
  }

  const fulfilled: T[] = [];
  const rejected: { index: number; reason: unknown }[] = [];

  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= tasks.length) return;
      try {
        const value = await tasks[i]();
        fulfilled.push(value);
      } catch (err) {
        rejected.push({ index: i, reason: err });
      }
    }
  }

  const workerCount = Math.min(concurrency, tasks.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  return { fulfilled, rejected };
}
