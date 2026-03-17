/**
 * useTreasuryStatus Hook Tests (AUDIT-12)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTreasuryStatus } from './useTreasuryStatus';

// Mock supabase (required by workerClient)
vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: 'test-token' } },
      }),
    },
  },
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

const mockTreasuryData = {
  wallet: { address: 'mx1abc...', balanceSats: 500000, utxoCount: 3 },
  network: { name: 'testnet4', blockHeight: 12345 },
  fees: { estimatorName: 'mempool', currentRateSatPerVbyte: 2 },
  recentAnchors: { totalSecured: 10, totalPending: 2, lastSecuredAt: '2026-03-17T00:00:00Z', last24hCount: 3 },
};

describe('useTreasuryStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockTreasuryData),
    });
  });

  it('starts with null status', () => {
    const { result } = renderHook(() => useTreasuryStatus());
    expect(result.current.status).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('fetches treasury status successfully', async () => {
    const { result } = renderHook(() => useTreasuryStatus());

    await act(async () => {
      await result.current.fetchStatus();
    });

    expect(result.current.status).toEqual(mockTreasuryData);
    expect(result.current.loading).toBe(false);
  });

  it('handles 403 access denied', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, json: () => Promise.resolve({}) });

    const { result } = renderHook(() => useTreasuryStatus());

    await act(async () => {
      await result.current.fetchStatus();
    });

    expect(result.current.error).toContain('platform admin');
  });

  it('handles network errors', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const { result } = renderHook(() => useTreasuryStatus());

    await act(async () => {
      await result.current.fetchStatus();
    });

    expect(result.current.error).toBeTruthy();
  });
});
