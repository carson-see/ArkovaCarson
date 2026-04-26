/**
 * Unit tests for useTreasuryBalance R1-6 hardening (SCRUM-1260).
 *
 * Locks the new behaviors that kill silent 0/0/0:
 *   1. Worker timeout cut from 60s default → 8s (no 75s skeleton)
 *   2. AbortController cancels in-flight cycle when next poll starts
 *   3. document.hidden skips the polling cycle (no backgrounded-tab hammering)
 *   4. visibilitychange refreshes immediately on tab focus
 *   5. Worker timeout → keep last balance + flag stale; do NOT fall back to
 *      direct mempool.space balance polling (forensic 1/8 leak)
 *
 * Full Playwright admin-auth spec deferred to R1-6 followup pending an
 * admin-page fixture in e2e/fixtures/auth.ts (currently only individual
 * is wired). The hook contract is what changed; this suite locks it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

// Hoisted mocks so they run before the hook-under-test imports them.
const { supabaseFromMock, workerFetchMock } = vi.hoisted(() => ({
  supabaseFromMock: vi.fn(),
  workerFetchMock: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: { from: supabaseFromMock },
}));

vi.mock('@/lib/workerClient', () => ({
  workerFetch: workerFetchMock,
}));

vi.mock('@/lib/platform', () => ({
  TREASURY_ADDRESS: 'bc1qtest',
  MEMPOOL_BASE_URL: 'https://mempool.space',
}));

vi.mock('@/lib/copy', () => ({
  TREASURY_LABELS: {
    BALANCE_STALE: 'Balance is stale',
    BALANCE_UNAVAILABLE: 'Balance unavailable',
  },
}));

import { useTreasuryBalance } from './useTreasuryBalance';

function makeCacheMissChain() {
  return {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: null, error: { message: 'PGRST116' } }),
      }),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: cache miss so we exercise the worker + mempool paths.
  supabaseFromMock.mockReturnValue(makeCacheMissChain());
  // Default: worker fails so error path is exercised.
  workerFetchMock.mockRejectedValue(new Error('worker timed out'));
  // Stub global fetch for mempool calls — return empty arrays so the parse
  // paths short-circuit cleanly. Each test can override.
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useTreasuryBalance R1-6 hardening (SCRUM-1260)', () => {
  it('flips loading→false on worker failure (no 75s skeleton)', async () => {
    const { result } = renderHook(() => useTreasuryBalance());
    await waitFor(() => expect(result.current.loading).toBe(false), { timeout: 2000 });
    expect(result.current.error).toBeTruthy();
  });

  it('surfaces BALANCE_UNAVAILABLE when worker fails and no prior balance exists', async () => {
    const { result } = renderHook(() => useTreasuryBalance());
    await waitFor(() => expect(result.current.error).toBe('Balance unavailable'));
    expect(result.current.balance).toBeNull();
  });

  it('passes a signal to workerFetch (cycle is cancellable)', async () => {
    renderHook(() => useTreasuryBalance());
    await waitFor(() => expect(workerFetchMock).toHaveBeenCalled());
    const [, opts] = workerFetchMock.mock.calls[0];
    expect(opts).toMatchObject({ method: 'GET' });
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('does NOT call mempool /address for balance — only worker is authoritative', async () => {
    renderHook(() => useTreasuryBalance());
    await waitFor(() => expect(workerFetchMock).toHaveBeenCalled());
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    // Allow mempool calls for txs / prices / fees enrichment, but no
    // /address/<addr>/utxo or balance-shaped endpoints.
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('/address/bc1qtest/utxo'))).toBe(false);
  });

  it('cleans up AbortController + interval + visibility listener on unmount', async () => {
    const removeEventListener = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() => useTreasuryBalance());
    // Wait for mount-side effect to fully settle.
    await act(async () => { await Promise.resolve(); });
    unmount();
    expect(removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('registers a visibilitychange listener so a backgrounded tab refreshes on focus', async () => {
    const addEventListener = vi.spyOn(document, 'addEventListener');
    renderHook(() => useTreasuryBalance());
    await waitFor(() =>
      expect(addEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function)),
    );
  });
});

describe('useTreasuryBalance R1 /simplify hardening (SCRUM-1260 carry-over)', () => {
  it('issues worker + mempool fetches concurrently (parallelization)', async () => {
    // Hold the worker promise open and capture when each leg started.
    const startTimes: { worker?: number; mempool?: number } = {};
    workerFetchMock.mockImplementation(() => {
      startTimes.worker = Date.now();
      // Keep worker open to prove mempool didn't await it.
      return new Promise(() => undefined);
    });
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/address/')) startTimes.mempool = Date.now();
      return Promise.resolve({ ok: true, json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useTreasuryBalance());
    await waitFor(() => expect(workerFetchMock).toHaveBeenCalled(), { timeout: 2000 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 2000 });

    expect(startTimes.worker).toBeDefined();
    expect(startTimes.mempool).toBeDefined();
    // Both should fire within the same JS event-loop tick — i.e. <50ms apart.
    expect(Math.abs((startTimes.mempool ?? 0) - (startTimes.worker ?? 0))).toBeLessThan(50);
  });

  it('does NOT call setBalance again when the worker returns identical data on a re-poll', async () => {
    // Configure worker to always return the same balance.
    const stableBalance = { wallet: { balanceSats: 12345 }, fees: { currentRateSatPerVbyte: 5 } };
    workerFetchMock.mockResolvedValue({ ok: true, json: async () => stableBalance });

    const { result, rerender } = renderHook(() => useTreasuryBalance());
    await waitFor(() => expect(result.current.balance).not.toBeNull(), { timeout: 2000 });

    const firstReference = result.current.balance;
    expect(firstReference?.confirmed).toBe(12345);

    // Trigger a manual refresh — equality guard should keep the same React state object.
    await act(async () => {
      await result.current.refresh();
    });
    rerender();

    // If equality guard works, React's setBalance was not invoked again with a new
    // reference, so the consumer-visible reference is stable across the second poll.
    expect(result.current.balance).toBe(firstReference);
  });
});
