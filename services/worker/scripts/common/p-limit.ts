/**
 * Minimal bounded-concurrency helper (no external dependency).
 *
 * Used by NVI-07 distillation + NVI-12 benchmark runner to rate-limit
 * outbound LLM calls. A typical distillation run spawns thousands of
 * variations; without a limiter a serial loop takes hours and a naive
 * `Promise.all` trips provider rate limits.
 *
 * Usage:
 *   const limit = pLimit(8);
 *   const results = await Promise.all(items.map((x) => limit(() => work(x))));
 */

export type PLimit = <T>(fn: () => Promise<T>) => Promise<T>;

export function pLimit(concurrency: number): PLimit {
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new Error(`pLimit: concurrency must be ≥ 1 (got ${concurrency})`);
  }
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    const run = queue.shift()!;
    active++;
    run();
  };

  return <T,>(fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        fn()
          .then((v) => {
            active--;
            resolve(v);
            next();
          })
          .catch((e) => {
            active--;
            reject(e);
            next();
          });
      };
      queue.push(run);
      next();
    });
}
