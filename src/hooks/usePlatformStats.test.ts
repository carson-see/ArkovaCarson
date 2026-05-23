import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryWrapper } from '@/tests/queryTestUtils';
import { usePlatformStats } from './usePlatformStats';

const mockWorkerFetch = vi.hoisted(() => vi.fn());

vi.mock('@/lib/workerClient', () => ({
  workerFetch: mockWorkerFetch,
}));

const platformStats = {
  users: { total: 62, last7Days: 4 },
  organizations: { total: 18 },
  anchors: {
    total: 3_200_000,
    byStatus: { SECURED: 3_199_990, PENDING: 10 },
    last24h: 42,
    avgSatsPerAnchor: null,
    totalFeeSats: null,
  },
  subscriptions: { byPlan: { Beta: 12 } },
};

describe('usePlatformStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetchStats loads platform stats even though the query does not auto-fetch', async () => {
    mockWorkerFetch.mockResolvedValue({
      ok: true,
      json: async () => platformStats,
    });

    const { result } = renderHook(() => usePlatformStats(), { wrapper: createQueryWrapper() });

    expect(result.current.stats).toBeNull();
    expect(mockWorkerFetch).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.fetchStats();
    });

    await waitFor(() => expect(result.current.stats?.users.total).toBe(62));
    expect(result.current.stats?.organizations.total).toBe(18);
    expect(result.current.stats?.anchors.total).toBe(3_200_000);
    expect(mockWorkerFetch).toHaveBeenCalledWith('/api/admin/platform-stats', { method: 'GET' });
  });
});
