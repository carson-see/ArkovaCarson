/**
 * SCRUM-1972 — useVersionResolution Hook Tests
 *
 * Verifies: fetch pending versions, resolve (approve/skip/flag), loading states.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVersionResolution } from './useVersionResolution';

const mockWorkerFetch = vi.fn();

vi.mock('@/lib/workerClient', () => ({
  workerFetch: (...args: unknown[]) => mockWorkerFetch(...args),
}));

describe('SCRUM-1972: useVersionResolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts with empty items and loading false', () => {
    const { result } = renderHook(() => useVersionResolution());
    expect(result.current.items).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('fetchPending calls worker API and sets items', async () => {
    const versions = [
      { id: 'v-1', filename: 'contract.pdf', source: 'docusign', status: 'pending_review', created_at: '2026-05-16T00:00:00Z' },
      { id: 'v-2', filename: 'offer.pdf', source: 'google_drive', status: 'pending_review', created_at: '2026-05-15T00:00:00Z' },
    ];
    mockWorkerFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ versions }),
    });

    const { result } = renderHook(() => useVersionResolution());

    await act(async () => {
      await result.current.fetchPending();
    });

    expect(mockWorkerFetch).toHaveBeenCalledWith('/api/v1/versions?status=pending_review');
    expect(result.current.items).toEqual(versions);
    expect(result.current.loading).toBe(false);
  });

  it('sets loading true while fetching', async () => {
    let resolvePromise: (v: unknown) => void;
    mockWorkerFetch.mockReturnValueOnce(new Promise(r => { resolvePromise = r; }));

    const { result } = renderHook(() => useVersionResolution());

    act(() => {
      result.current.fetchPending();
    });

    expect(result.current.loading).toBe(true);

    await act(async () => {
      resolvePromise!({ ok: true, json: async () => ({ versions: [] }) });
    });

    expect(result.current.loading).toBe(false);
  });

  it('resolve calls POST with decision and notes', async () => {
    mockWorkerFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, decision: 'approve', version_id: 'v-1', status: 'approved' }),
    });

    const { result } = renderHook(() => useVersionResolution());

    await act(async () => {
      await result.current.resolve('v-1', 'approve', 'Looks good');
    });

    expect(mockWorkerFetch).toHaveBeenCalledWith('/api/v1/versions/v-1/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', notes: 'Looks good' }),
    });
  });

  it('resolve returns the response data', async () => {
    const responseData = { success: true, decision: 'skip', version_id: 'v-2', status: 'skipped' };
    mockWorkerFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => responseData,
    });

    const { result } = renderHook(() => useVersionResolution());

    let resolveResult: unknown;
    await act(async () => {
      resolveResult = await result.current.resolve('v-2', 'skip');
    });

    expect(resolveResult).toEqual(responseData);
  });

  it('handles fetch error gracefully', async () => {
    mockWorkerFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const { result } = renderHook(() => useVersionResolution());

    await act(async () => {
      await result.current.fetchPending();
    });

    expect(result.current.items).toEqual([]);
    expect(result.current.error).toBe('Failed to load version conflicts');
  });

  it('handles resolve error gracefully', async () => {
    mockWorkerFetch.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: 'forbidden' }) });

    const { result } = renderHook(() => useVersionResolution());

    let resolveResult: unknown;
    await act(async () => {
      resolveResult = await result.current.resolve('v-1', 'approve');
    });

    expect(resolveResult).toBeNull();
    expect(result.current.error).toBe('Resolution failed');
  });
});
