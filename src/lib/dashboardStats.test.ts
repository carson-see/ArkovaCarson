import { describe, expect, it } from 'vitest';
import { resolveDashboardStatsRequest, resolveDashboardStatsState } from './dashboardStats';

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

describe('resolveDashboardStatsRequest', () => {
  it('waits for profile resolution before choosing a stats RPC', () => {
    expect(resolveDashboardStatsRequest({
      userId: 'user-1',
      profileLoading: true,
      profileRole: undefined,
      profileOrgId: undefined,
    })).toBeNull();
  });

  it('uses org stats for resolved org admins with an org id', () => {
    expect(resolveDashboardStatsRequest({
      userId: 'user-1',
      profileLoading: false,
      profileRole: 'ORG_ADMIN',
      profileOrgId: 'org-1',
    })).toEqual({
      rpcName: 'get_org_anchor_stats',
      rpcParam: { p_org_id: 'org-1' },
      requestKey: 'get_org_anchor_stats:org-1',
    });
  });

  it('uses user stats only after a non-org profile has resolved', () => {
    expect(resolveDashboardStatsRequest({
      userId: 'user-1',
      profileLoading: false,
      profileRole: 'INDIVIDUAL',
      profileOrgId: null,
    })).toEqual({
      rpcName: 'get_user_anchor_stats',
      rpcParam: { p_user_id: 'user-1' },
      requestKey: 'get_user_anchor_stats:user-1',
    });
  });
});
