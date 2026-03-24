/**
 * System Health Admin Dashboard
 *
 * Internal-only ops page for Arkova platform administrators.
 * Shows real-time system health: service checks, memory usage,
 * uptime, version, and configuration status.
 *
 * CRITICAL: This page is ONLY accessible to hardcoded Arkova admin emails.
 * Third-party org admins and external users must NEVER see this data.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Server,
  Database,
  Activity,
  Cpu,
  RefreshCw,
  CheckCircle,
  XCircle,
  Clock,
  Zap,
  AlertTriangle,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ROUTES } from '@/lib/routes';
import { SYSTEM_HEALTH_LABELS } from '@/lib/copy';

import { isPlatformAdmin } from '@/lib/platform';

/** Auto-refresh interval in milliseconds */
const AUTO_REFRESH_MS = 30_000;

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

export function SystemHealthPage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const { health, loading: healthLoading, error: healthError, fetchHealth } = useSystemHealth();

  const [refreshing, setRefreshing] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isAdmin = isPlatformAdmin(user?.email);

  useEffect(() => {
    if (isAdmin) {
      fetchHealth();

      intervalRef.current = setInterval(() => {
        fetchHealth();
      }, AUTO_REFRESH_MS);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [isAdmin, fetchHealth]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    fetchHealth().finally(() => {
      setRefreshing(false);
    });
  }, [fetchHealth]);

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
            System health is restricted to Arkova administrators.
          </p>
          <Button variant="outline" onClick={() => navigate(ROUTES.DASHBOARD)}>
            Back to Dashboard
          </Button>
        </div>
      </AppShell>
    );
  }

  const statusColorMap = {
    healthy: 'bg-green-500/10 text-green-700 border-green-500/30',
    degraded: 'bg-amber-500/10 text-amber-700 border-amber-500/30',
    down: 'bg-red-500/10 text-red-700 border-red-500/30',
  };

  const statusLabelMap = {
    healthy: 'All Systems Operational',
    degraded: 'Degraded Performance',
    down: 'System Down',
  };

  return (
    <AppShell user={user} profile={profile} profileLoading={profileLoading} onSignOut={handleSignOut}>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            System Health
          </h1>
          <p className="text-muted-foreground mt-1">
            Real-time service status and resource usage
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
      {healthError && (
        <div className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-400 dark:border-amber-500/20 dark:bg-amber-500/5">
          <AlertTriangle className="inline h-4 w-4 mr-2" />
          {SYSTEM_HEALTH_LABELS.CONNECTION_ERROR}
          <p className="mt-2 text-xs opacity-70">
            {SYSTEM_HEALTH_LABELS.WORKER_HINT}
          </p>
        </div>
      )}

      {/* Overall Status Banner */}
      <div className="mb-8">
        {healthLoading ? (
          <Skeleton className="h-16 w-full rounded-lg" />
        ) : health ? (
          <div className={`rounded-lg border p-4 flex items-center gap-4 ${statusColorMap[health.status]}`}>
            {health.status === 'healthy' && <CheckCircle className="h-6 w-6" />}
            {health.status === 'degraded' && <AlertTriangle className="h-6 w-6" />}
            {health.status === 'down' && <XCircle className="h-6 w-6" />}
            <div>
              <p className="font-semibold text-lg">
                {statusLabelMap[health.status]}
              </p>
              <p className="text-sm opacity-80">
                Auto-refreshes every 30 seconds
              </p>
            </div>
          </div>
        ) : null}
      </div>

      {/* Service Checks */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 mb-8">
        {/* Supabase */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Supabase</CardTitle>
            <Database className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {healthLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-4 w-24" />
              </div>
            ) : health?.checks.supabase ? (
              <div className="space-y-2">
                {health.checks.supabase.status === 'ok' ? (
                  <Badge className="bg-green-500/10 text-green-700 border-green-500/30">
                    <CheckCircle className="mr-1 h-3 w-3" />
                    Connected
                  </Badge>
                ) : (
                  <Badge className="bg-red-500/10 text-red-700 border-red-500/30">
                    <XCircle className="mr-1 h-3 w-3" />
                    Error
                  </Badge>
                )}
                {health.checks.supabase.latencyMs !== undefined && (
                  <p className="text-sm text-muted-foreground">
                    Latency: <span className="font-mono">{health.checks.supabase.latencyMs}ms</span>
                  </p>
                )}
                {health.checks.supabase.message && (
                  <p className="text-xs text-muted-foreground">{health.checks.supabase.message}</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{SYSTEM_HEALTH_LABELS.WORKER_OFFLINE}</p>
            )}
          </CardContent>
        </Card>

        {/* Bitcoin */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Anchor Network</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {healthLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-4 w-24" />
              </div>
            ) : health?.checks.bitcoin ? (
              <div className="space-y-2">
                {health.checks.bitcoin.connected ? (
                  <Badge className="bg-green-500/10 text-green-700 border-green-500/30">
                    <CheckCircle className="mr-1 h-3 w-3" />
                    Connected
                  </Badge>
                ) : (
                  <Badge className="bg-red-500/10 text-red-700 border-red-500/30">
                    <XCircle className="mr-1 h-3 w-3" />
                    Disconnected
                  </Badge>
                )}
                <p className="text-sm text-muted-foreground">
                  Network: <Badge variant="secondary" className="font-mono text-xs ml-1">{health.checks.bitcoin.network}</Badge>
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{SYSTEM_HEALTH_LABELS.WORKER_OFFLINE}</p>
            )}
          </CardContent>
        </Card>

        {/* Stripe */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Stripe</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {healthLoading ? (
              <Skeleton className="h-5 w-16 rounded-full" />
            ) : (
              <ConfigBadge configured={health?.config.stripe ?? false} />
            )}
          </CardContent>
        </Card>

        {/* Sentry */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Sentry</CardTitle>
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {healthLoading ? (
              <Skeleton className="h-5 w-16 rounded-full" />
            ) : (
              <ConfigBadge configured={health?.config.sentry ?? false} />
            )}
          </CardContent>
        </Card>

        {/* AI */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">AI Provider</CardTitle>
            <Cpu className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {healthLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-4 w-24" />
              </div>
            ) : health?.config.ai ? (
              <div className="space-y-2">
                <ConfigBadge configured={health.config.ai.configured} />
                <p className="text-sm text-muted-foreground">
                  Provider: <Badge variant="secondary" className="font-mono text-xs ml-1">{health.config.ai.provider}</Badge>
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{SYSTEM_HEALTH_LABELS.WORKER_OFFLINE}</p>
            )}
          </CardContent>
        </Card>

        {/* Email */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Email</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {healthLoading ? (
              <Skeleton className="h-5 w-16 rounded-full" />
            ) : (
              <ConfigBadge configured={health?.config.email ?? false} />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Memory + Uptime + Version */}
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2 mb-8">
        {/* Memory Usage */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Memory Usage</CardTitle>
            <Cpu className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {healthLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-40" />
              </div>
            ) : health?.memory ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Heap Used</span>
                  <span className="font-mono text-sm font-semibold">
                    {health.memory.heapUsedMB.toFixed(1)} MB
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Heap Total</span>
                  <span className="font-mono text-sm">
                    {health.memory.heapTotalMB.toFixed(1)} MB
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">RSS</span>
                  <span className="font-mono text-sm">
                    {health.memory.rssMB.toFixed(1)} MB
                  </span>
                </div>
                {health.memory.heapTotalMB > 0 && (
                  <div className="pt-2 border-t">
                    <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                      <span>Heap Utilization</span>
                      <span>{((health.memory.heapUsedMB / health.memory.heapTotalMB) * 100).toFixed(0)}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{ width: `${Math.min((health.memory.heapUsedMB / health.memory.heapTotalMB) * 100, 100)}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No memory data available.</p>
            )}
          </CardContent>
        </Card>

        {/* Uptime + Version */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Runtime</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {healthLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-32" />
              </div>
            ) : health ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Uptime</span>
                  <span className="font-mono text-sm font-semibold">
                    {formatUptime(health.uptime)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Version</span>
                  <Badge variant="secondary" className="font-mono text-xs">
                    {health.version}
                  </Badge>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No runtime data available.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

function ConfigBadge({ configured }: Readonly<{ configured: boolean }>) {
  return configured ? (
    <Badge className="bg-green-500/10 text-green-700 border-green-500/30">
      <CheckCircle className="mr-1 h-3 w-3" />
      Configured
    </Badge>
  ) : (
    <Badge className="bg-red-500/10 text-red-700 border-red-500/30">
      <XCircle className="mr-1 h-3 w-3" />
      Not Configured
    </Badge>
  );
}
