/**
 * Platform Overview Admin Dashboard
 *
 * Internal-only ops page for Arkova platform administrators.
 * Shows aggregate platform metrics: users, orgs, records, subscriptions.
 *
 * CRITICAL: This page is ONLY accessible to hardcoded Arkova admin emails.
 * Third-party org admins and external users must NEVER see this data.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Users,
  Building2,
  FileText,
  CreditCard,
  RefreshCw,
  Clock,
  Activity,
  BarChart3,
  AlertTriangle,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { usePlatformStats } from '@/hooks/usePlatformStats';
import { AppShell } from '@/components/layout';
import { StatCard } from '@/components/dashboard/StatCard';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ROUTES } from '@/lib/routes';

import { isPlatformAdmin } from '@/lib/platform';

export function PlatformOverviewPage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const { stats, loading: statsLoading, error: statsError, fetchStats } = usePlatformStats();

  const [refreshing, setRefreshing] = useState(false);

  const isAdmin = isPlatformAdmin(user?.email);

  useEffect(() => {
    if (isAdmin) {
      fetchStats();
    }
  }, [isAdmin, fetchStats]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    fetchStats().finally(() => {
      setRefreshing(false);
    });
  }, [fetchStats]);

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  // Unauthorized view
  if (!profileLoading && !isAdmin) {
    return (
      <AppShell user={user} profile={profile} profileLoading={profileLoading} onSignOut={handleSignOut}>
        <div className="flex flex-col items-center justify-center py-20">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-destructive/10 mb-4">
            <AlertTriangle className="h-8 w-8 text-destructive" />
          </div>
          <h2 className="text-xl font-semibold mb-2">Unauthorized</h2>
          <p className="text-muted-foreground text-sm mb-4">
            Platform overview is restricted to Arkova administrators.
          </p>
          <Button variant="outline" onClick={() => navigate(ROUTES.DASHBOARD)}>
            Back to Dashboard
          </Button>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} profile={profile} profileLoading={profileLoading} onSignOut={handleSignOut}>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Platform Overview
          </h1>
          <p className="text-muted-foreground mt-1">
            Aggregate metrics across the Arkova platform
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Error banner */}
      {statsError && (
        <div className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700">
          <AlertTriangle className="inline h-4 w-4 mr-2" />
          {statsError}
        </div>
      )}

      {/* Top row: 4 StatCards — clickable to detail lists */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 mb-8">
        <div className="cursor-pointer" onClick={() => navigate(ROUTES.ADMIN_USERS)}>
          <StatCard
            label="Total Users"
            value={stats?.users.total ?? 0}
            icon={Users}
            loading={statsLoading}
            variant="primary"
          />
        </div>
        <StatCard
          label="Total Organizations"
          value={stats?.organizations.total ?? 0}
          icon={Building2}
          loading={statsLoading}
          variant="default"
        />
        <div className="cursor-pointer" onClick={() => navigate(ROUTES.ADMIN_RECORDS)}>
          <StatCard
            label="Total Records"
            value={stats?.anchors.total ?? 0}
            icon={FileText}
            loading={statsLoading}
            variant="success"
          />
        </div>
        <div className="cursor-pointer" onClick={() => navigate(ROUTES.ADMIN_SUBSCRIPTIONS)}>
          <StatCard
            label="Active Subscriptions"
            value={stats ? Object.values(stats.subscriptions.byPlan).reduce((a, b) => a + b, 0) : 0}
            icon={CreditCard}
            loading={statsLoading}
            variant="warning"
          />
        </div>
      </div>

      {/* Second row: New Users (7d) and Records (24h) */}
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2 mb-8">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              New Users (7d)
            </CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-12 w-24" />
            ) : (
              <p className="text-4xl font-black tracking-tighter">
                {stats?.users.last7Days ?? 0}
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-2">
              Users who signed up in the last 7 days
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Records (24h)
            </CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-12 w-24" />
            ) : (
              <p className="text-4xl font-black tracking-tighter">
                {stats?.anchors.last24h ?? 0}
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-2">
              Records created in the last 24 hours
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Third section: Anchors by Status */}
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2 mb-8">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Records by Status
            </CardTitle>
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={`skeleton-status-${i}`} className="flex items-center justify-between">
                    <Skeleton className="h-5 w-20 rounded-full" />
                    <Skeleton className="h-4 w-12" />
                  </div>
                ))}
              </div>
            ) : stats?.anchors.byStatus ? (
              <div className="space-y-3">
                {Object.entries(stats.anchors.byStatus).map(([status, count]) => (
                  <div key={status} className="flex items-center justify-between">
                    <AnchorStatusBadge status={status} />
                    <span className="font-mono text-sm font-semibold">
                      {count.toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-6">
                No status data available.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Fourth section: Subscriptions by Plan */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Subscriptions by Plan
            </CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={`skeleton-plan-${i}`} className="flex items-center justify-between">
                    <Skeleton className="h-5 w-24 rounded-full" />
                    <Skeleton className="h-4 w-12" />
                  </div>
                ))}
              </div>
            ) : stats?.subscriptions.byPlan ? (
              <div className="space-y-3">
                {Object.entries(stats.subscriptions.byPlan).map(([plan, count]) => (
                  <div key={plan} className="flex items-center justify-between">
                    <Badge variant="secondary" className="capitalize">
                      {plan}
                    </Badge>
                    <span className="font-mono text-sm font-semibold">
                      {count.toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-6">
                No subscription data available.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

function AnchorStatusBadge({ status }: Readonly<{ status: string }>) {
  switch (status) {
    case 'SECURED':
      return <Badge className="bg-green-500/10 text-green-700 border-green-500/30">Secured</Badge>;
    case 'PENDING':
      return <Badge className="bg-amber-500/10 text-amber-700 border-amber-500/30">Pending</Badge>;
    case 'SUBMITTED':
      return <Badge className="bg-blue-500/10 text-blue-700 border-blue-500/30">Submitted</Badge>;
    case 'REVOKED':
      return <Badge variant="secondary">Revoked</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}
