/**
 * useOpsSloStats Hook Tests (SCRUM-2401)
 *
 * Mirrors useSystemHealth.ts's contract exactly: `loading` starts true but the
 * hook does NOT self-fetch on mount — the caller (normally the page's
 * useVisibilityPolling) triggers the first fetch via `refetch()`. Covers
 * loading, empty/zero-state, success, breach, and error paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockWorkerFetch = vi.hoisted(() => vi.fn());

vi.mock('@/lib/workerClient', () => ({
  workerFetch: mockWorkerFetch,
}));

import { useOpsSloStats } from './useOpsSloStats';

function healthyPayload() {
  return {
    anchorSecuredRate: {
      available: true, securedCount: 992, totalCount: 1000, ratePct: 99.2,
      cacheUpdatedAt: '2026-07-06T00:00:00Z', breach: false, error: null,
    },
    connectorQueue: {
      available: true, depth: 2, anchored: 100, failed: 1, breach: false, error: null,
    },
    creditConservation: {
      available: true, orgsChecked: 10, divergedCount: 0, divergedOrgIds: [], breach: false, error: null,
    },
    webhookDelivery: {
      available: true, successCount: 95, totalCount: 100, ratePct: 95, windowHours: 24, breach: false, error: null,
    },
    apiErrors: {
      available: true, errorCount: 1, totalCount: 100, errorRatePct: 1, windowHours: 24, breach: false, error: null,
    },
    overallBreach: false,
    checkedAt: '2026-07-06T00:00:00Z',
  };
}

describe('useOpsSloStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts in a loading state with no stats and does not auto-fetch', () => {
    const { result } = renderHook(() => useOpsSloStats());
    expect(result.current.loading).toBe(true);
    expect(result.current.stats).toBeNull();
    expect(result.current.error).toBeNull();
    expect(mockWorkerFetch).not.toHaveBeenCalled();
  });

  it('fetches and exposes SLO stats on refetch()', async () => {
    mockWorkerFetch.mockResolvedValue({ ok: true, json: async () => healthyPayload() });
    const { result } = renderHook(() => useOpsSloStats());

    await act(async () => {
      await result.current.refetch();
    });

    expect(mockWorkerFetch).toHaveBeenCalledWith('/api/admin/ops-slo-stats', { method: 'GET' });
    expect(result.current.loading).toBe(false);
    expect(result.current.stats).toEqual(healthyPayload());
    expect(result.current.error).toBeNull();
  });

  it('surfaces a breach via stats.overallBreach', async () => {
    const breached = { ...healthyPayload(), overallBreach: true };
    breached.creditConservation = { ...breached.creditConservation, divergedCount: 1, breach: true };
    mockWorkerFetch.mockResolvedValue({ ok: true, json: async () => breached });

    const { result } = renderHook(() => useOpsSloStats());
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.stats?.overallBreach).toBe(true);
    expect(result.current.stats?.creditConservation.breach).toBe(true);
  });

  it('handles a zero-count / empty-state payload without erroring', async () => {
    const empty = {
      anchorSecuredRate: { available: true, securedCount: 0, totalCount: 0, ratePct: null, cacheUpdatedAt: null, breach: false, error: null },
      connectorQueue: { available: true, depth: 0, anchored: 0, failed: 0, breach: false, error: null },
      creditConservation: { available: true, orgsChecked: 0, divergedCount: 0, divergedOrgIds: [], breach: false, error: null },
      webhookDelivery: { available: true, successCount: 0, totalCount: 0, ratePct: null, windowHours: 24, breach: false, error: null },
      apiErrors: { available: true, errorCount: 0, totalCount: 0, errorRatePct: null, windowHours: 24, breach: false, error: null },
      overallBreach: false,
      checkedAt: '2026-07-06T00:00:00Z',
    };
    mockWorkerFetch.mockResolvedValue({ ok: true, json: async () => empty });

    const { result } = renderHook(() => useOpsSloStats());
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.stats).toEqual(empty);
    expect(result.current.stats?.anchorSecuredRate.totalCount).toBe(0);
    expect(result.current.loading).toBe(false);
  });

  it('surfaces a non-ok response as an error and leaves stats null', async () => {
    mockWorkerFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Forbidden — platform admin access required' }),
    });

    const { result } = renderHook(() => useOpsSloStats());
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.stats).toBeNull();
    expect(result.current.error).toBe('Forbidden — platform admin access required');
  });

  it('surfaces a network failure as an error', async () => {
    mockWorkerFetch.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useOpsSloStats());
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.stats).toBeNull();
    expect(result.current.error).toBe('network down');
  });

  it('refetch() re-invokes the worker fetch and clears a prior error on success', async () => {
    mockWorkerFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const { result } = renderHook(() => useOpsSloStats());
    await act(async () => {
      await result.current.refetch();
    });
    // No `error` field in the body → the hook falls back to the HTTP status.
    expect(result.current.error).toBe('HTTP 500');

    mockWorkerFetch.mockResolvedValueOnce({ ok: true, json: async () => healthyPayload() });
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.stats).toEqual(healthyPayload());
    expect(mockWorkerFetch).toHaveBeenCalledTimes(2);
  });
});
