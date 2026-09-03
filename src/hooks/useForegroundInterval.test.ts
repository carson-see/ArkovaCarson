/**
 * useForegroundInterval tests — SCRUM-3167 review batch (items 13/S2/EA3).
 *
 * `useMfaAssurance.ts` and `useMfaEnrollmentRequirement.ts` each hand-rolled
 * an identical "60s interval + re-fire on visibilitychange" effect for the
 * CTO's A4-11 live-re-evaluation ruling. This hook is the single shared
 * implementation both now use.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useForegroundInterval } from './useForegroundInterval';

function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
  Object.defineProperty(document, 'visibilityState', {
    value: hidden ? 'hidden' : 'visible',
    configurable: true,
  });
}

describe('useForegroundInterval', () => {
  afterEach(() => {
    vi.useRealTimers();
    setDocumentHidden(false);
  });

  it('does not call the callback synchronously on mount', () => {
    const cb = vi.fn();
    renderHook(() => useForegroundInterval(cb, 60_000));
    expect(cb).not.toHaveBeenCalled();
  });

  it('calls the callback on the interval while mounted', async () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    renderHook(() => useForegroundInterval(cb, 60_000));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(cb).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('calls the callback when the tab becomes visible again', () => {
    const cb = vi.fn();
    renderHook(() => useForegroundInterval(cb, 60_000));

    setDocumentHidden(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(cb).not.toHaveBeenCalled();

    setDocumentHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not re-arm the interval/listener on every render when callback identity changes (uses a ref internally)', () => {
    vi.useFakeTimers();
    let cb = vi.fn();
    const { rerender } = renderHook(({ callback }) => useForegroundInterval(callback, 60_000), {
      initialProps: { callback: cb },
    });

    cb = vi.fn();
    rerender({ callback: cb });

    // Still fires the LATEST callback after a rerender with a new identity —
    // proves it reads live state rather than a stale closure.
    return vi.advanceTimersByTimeAsync(60_000).then(() => {
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  it('cleans up the interval and the visibilitychange listener on unmount', async () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    const removeListenerSpy = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() => useForegroundInterval(cb, 60_000));

    unmount();
    expect(removeListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

    await vi.advanceTimersByTimeAsync(120_000);
    expect(cb).not.toHaveBeenCalled();
  });

  it('respects a null/disabled sentinel via the enabled flag (no interval, no listener)', async () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    renderHook(() => useForegroundInterval(cb, 60_000, false));

    await vi.advanceTimersByTimeAsync(120_000);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(cb).not.toHaveBeenCalled();
  });
});
