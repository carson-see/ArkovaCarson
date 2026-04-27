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
});
