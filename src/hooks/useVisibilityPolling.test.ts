/**
 * Unit tests for useVisibilityPolling.
 *
 * Locks the contract extracted from AnchorQueuePage / useTreasuryBalance /
 * PipelineAdminPage during the SCRUM-1260 (R1-6) /simplify pass:
 *   1. cb fires once on mount.
 *   2. cb fires every intervalMs while document.hidden === false.
 *   3. cb is skipped when document.hidden === true.
 *   4. cb fires immediately when the tab returns to the foreground.
 *   5. interval + listener are torn down on unmount.
 *   6. rejected cb promises do not propagate to React.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useVisibilityPolling } from './useVisibilityPolling';

describe('useVisibilityPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fires cb once on mount', () => {
    const cb = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useVisibilityPolling(cb, 30_000));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('fires cb every intervalMs when tab is visible', async () => {
    const cb = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useVisibilityPolling(cb, 30_000));
    expect(cb).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(cb).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('skips cb when document.hidden is true', async () => {
    const cb = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useVisibilityPolling(cb, 30_000));
    expect(cb).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'hidden', { configurable: true, value: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('fires cb immediately on visibilitychange when tab returns to foreground', async () => {
    const cb = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useVisibilityPolling(cb, 30_000));
    expect(cb).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(cb).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('clears interval and removes listener on unmount', async () => {
    const cb = vi.fn().mockResolvedValue(undefined);
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() => useVisibilityPolling(cb, 30_000));

    unmount();

    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('swallows rejected cb promises so they do not crash the React tree', async () => {
    const cb = vi.fn().mockRejectedValue(new Error('boom'));
    expect(() => renderHook(() => useVisibilityPolling(cb, 30_000))).not.toThrow();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('handles a sync cb (void return) without rejecting', async () => {
    const cb = vi.fn(() => undefined);
    expect(() => renderHook(() => useVisibilityPolling(cb, 30_000))).not.toThrow();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------
  // SCRUM-3167 (PR #2637 review, R7): extended with `options.immediate`
  // (default `true` — every existing caller above is unaffected) and
  // `options.enabled`, plus the ref-for-callback discipline `
  // useForegroundInterval` had (this hook now replaces it — see that
  // file's deletion note).
  // ---------------------------------------------------------------------

  it('R7: immediate:false skips the mount-time fire, but still polls on the interval', async () => {
    const cb = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useVisibilityPolling(cb, 30_000, { immediate: false }));
    expect(cb).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('R7: immediate defaults to true when options is omitted entirely (backward compatible)', () => {
    const cb = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useVisibilityPolling(cb, 30_000));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('R7: enabled:false skips the mount fire, the interval, and the visibility listener entirely', async () => {
    const cb = vi.fn().mockResolvedValue(undefined);
    const addSpy = vi.spyOn(document, 'addEventListener');
    renderHook(() => useVisibilityPolling(cb, 30_000, { enabled: false }));

    expect(cb).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(cb).not.toHaveBeenCalled();
    expect(addSpy).not.toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('R7: does not re-arm the interval/listener just because a new cb identity is passed on re-render (ref discipline)', async () => {
    let cb = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(({ callback }) => useVisibilityPolling(callback, 30_000, { immediate: false }), {
      initialProps: { callback: cb },
    });

    cb = vi.fn().mockResolvedValue(undefined);
    rerender({ callback: cb });

    // The LATEST callback still fires on the next tick — proves the hook
    // reads live state via a ref rather than closing over a stale one.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('R7: a callback-identity change alone does not trigger a duplicate immediate fire', () => {
    let cb = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(({ callback }) => useVisibilityPolling(callback, 30_000), {
      initialProps: { callback: cb },
    });
    expect(cb).toHaveBeenCalledTimes(1);

    const secondCb = vi.fn().mockResolvedValue(undefined);
    cb = secondCb;
    rerender({ callback: cb });

    // Re-rendering with a new (unmemoized) callback must not re-fire the
    // "immediate" mount behaviour again — that would make `immediate` a
    // footgun for any caller that doesn't memoize its callback.
    expect(secondCb).not.toHaveBeenCalled();
  });
});
