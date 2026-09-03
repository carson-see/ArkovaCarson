/**
 * withTimeout tests (SCRUM-3167 review batch, items 5/D5/R2/S1).
 *
 * Root cause: two hand-rolled `Promise.race([op, timeout(ms)])` helpers
 * (`useMfaAssurance.ts`, `MfaEnrollmentRequired.tsx`) never cleared the
 * losing timer on the WINNING path — every successful check/enroll left an
 * orphaned `setTimeout` running for up to 8s, and a rapidly-flapping
 * visibilitychange listener could accumulate many of them concurrently.
 * `withTimeout` is the single shared replacement: it always clears its own
 * timer once the race settles, whichever side wins.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTimeout, TimeoutError } from './async';

describe('withTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the inner promise value when it settles before the timeout', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1_000, 'test-op')).resolves.toBe('ok');
  });

  it('rejects with the inner promise error when it rejects before the timeout', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1_000, 'test-op')).rejects.toThrow('boom');
  });

  it('rejects with a TimeoutError naming the label when the inner promise never settles', async () => {
    vi.useFakeTimers();
    const never = new Promise(() => {});

    const result = withTimeout(never, 5_000, 'test-op');
    const assertion = expect(result).rejects.toThrow(TimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it('CLEARS its timer on the winning (fast-resolve) path — no orphaned timer left pending', async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(global, 'clearTimeout');

    await withTimeout(Promise.resolve('fast'), 8_000, 'test-op');
    // Flush microtasks so the .then/.finally chain inside withTimeout runs
    // under fake timers before we assert.
    await vi.advanceTimersByTimeAsync(0);

    expect(clearSpy).toHaveBeenCalled();
    // Advancing well past the timeout must not throw/reject anything else —
    // there is nothing left pending to fire.
    await vi.advanceTimersByTimeAsync(10_000);
  });

  it('CLEARS its timer on the winning (fast-reject) path too', async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(global, 'clearTimeout');

    await withTimeout(Promise.reject(new Error('x')), 8_000, 'test-op').catch(() => {});
    await vi.advanceTimersByTimeAsync(0);

    expect(clearSpy).toHaveBeenCalled();
  });

  it('does not leave a dangling unhandled rejection from the timeout side after the real promise wins', async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    await withTimeout(Promise.resolve('fast'), 100, 'test-op');
    await vi.advanceTimersByTimeAsync(200);

    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
