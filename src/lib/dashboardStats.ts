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
