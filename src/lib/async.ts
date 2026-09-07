/**
 * Shared async helpers — SCRUM-3167 code-review batch (items 5/D5/R2/S1).
 *
 * `useMfaAssurance.ts` and `MfaEnrollmentRequired.tsx` each hand-rolled the
 * same `Promise.race([op, timeout(ms)])` pattern (a third copy already
 * existed in `fileHasher.ts`). None of them cleared the LOSING timer on the
 * WINNING path: every successful check/enroll left an orphaned `setTimeout`
 * running for up to the full timeout window, and a hook that re-checks on a
 * fast cadence (`useMfaAssurance`'s 60s tick + visibilitychange) could
 * accumulate several of these concurrently under flapping tab visibility.
 * `withTimeout` is the single shared replacement — it always clears its own
 * timer once the race settles, whichever side wins.
 */

/** Thrown when the wrapped promise does not settle within the given budget. */
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Race `promise` against a `ms`-millisecond timeout, clearing the timer on
 * EITHER outcome so a fast-settling promise never leaves a dangling timer
 * behind. `label` names the operation in the thrown `TimeoutError` message
 * only — it carries no PII and is safe to log/report.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}
