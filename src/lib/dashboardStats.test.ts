import { describe, expect, it } from 'vitest';
import { resolveDashboardStatsState } from './dashboardStats';

describe('resolveDashboardStatsState', () => {
  const records = [
    { status: 'SECURED' },
    { status: 'PENDING' },
    { status: 'REVOKED' },
  ];

  it('uses RPC stats when available', () => {
    expect(resolveDashboardStatsState({
      rpcStats: { total: 12, secured: 10, pending: 2 },
      records,
      statsError: null,
    })).toEqual({
      stats: { total: 12, secured: 10, pending: 2 },
      error: null,
    });
  });

  it('falls back to visible records before the RPC has returned', () => {
    expect(resolveDashboardStatsState({
      rpcStats: null,
      records,
      statsError: null,
    })).toEqual({
      stats: { total: 3, secured: 1, pending: 1 },
      error: null,
    });
  });

  it('does not fall back to zeros or visible records after the stats RPC fails', () => {
    expect(resolveDashboardStatsState({
      rpcStats: null,
      records,
      statsError: 'Unable to load dashboard stats',
    })).toEqual({
      stats: null,
      error: 'Unable to load dashboard stats',
    });
  });
});
