export interface DashboardStats {
  total: number;
  secured: number;
  pending: number;
}

interface DashboardStatsRecord {
  status?: string | null;
}

interface DashboardStatsStateInput {
  rpcStats: DashboardStats | null;
  records: DashboardStatsRecord[];
  statsError: string | null;
}

interface DashboardStatsState {
  stats: DashboardStats | null;
  error: string | null;
}

interface DashboardStatsRequestInput {
  userId: string | undefined;
  profileLoading: boolean;
  profileRole: string | null | undefined;
  profileOrgId: string | null | undefined;
}

interface DashboardStatsRequest {
  rpcName: 'get_org_anchor_stats' | 'get_user_anchor_stats';
  rpcParam: { p_org_id: string } | { p_user_id: string };
  requestKey: string;
}

export function resolveDashboardStatsRequest({
  userId,
  profileLoading,
  profileRole,
  profileOrgId,
}: DashboardStatsRequestInput): DashboardStatsRequest | null {
  if (!userId || profileLoading) return null;

  if (profileRole === 'ORG_ADMIN' && profileOrgId) {
    return {
      rpcName: 'get_org_anchor_stats',
      rpcParam: { p_org_id: profileOrgId },
      requestKey: `get_org_anchor_stats:${profileOrgId}`,
    };
  }

  return {
    rpcName: 'get_user_anchor_stats',
    rpcParam: { p_user_id: userId },
    requestKey: `get_user_anchor_stats:${userId}`,
  };
}

export function resolveDashboardStatsState({
  rpcStats,
  records,
  statsError,
}: DashboardStatsStateInput): DashboardStatsState {
  if (statsError) {
    return { stats: null, error: statsError };
  }

  if (rpcStats) {
    return { stats: rpcStats, error: null };
  }

  return {
    stats: {
      total: records.length,
      secured: records.filter((record) => record.status === 'SECURED').length,
      pending: records.filter((record) => record.status === 'PENDING').length,
    },
    error: null,
  };
}
