/**
 * Treasury Admin Dashboard
 *
 * Internal-only ops page for Arkova platform administrators.
 * Shows anchor processing stats (real Supabase data) and
 * treasury vault overview (requires worker API — placeholder until wired).
 *
 * Banned terminology rules are RELAXED for this internal page (per MVP-15 decision).
 *
 * @see GAP-01
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  RefreshCw,
  Clock,
  CheckCircle,
  XCircle,
  Lock,
  Activity,
  Server,
  AlertTriangle,
  FileText,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ROUTES } from '@/lib/routes';
import { TREASURY_LABELS } from '@/lib/copy';
import { supabase } from '@/lib/supabase';

/** Hardcoded admin emails — will be replaced with PLATFORM_ADMIN role in future */
const PLATFORM_ADMIN_EMAILS = [
  'admin@arkova.io',
  'admin_demo@arkova.local',
  'admin@umich-demo.arkova.io',
];

interface AnchorStats {
  total: number;
  pending: number;
  secured: number;
  revoked: number;
}

interface RecentAnchor {
  id: string;
  public_id: string | null;
  filename: string;
  status: string;
  created_at: string;
  credential_type: string | null;
}

export function TreasuryAdminPage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();

  const [stats, setStats] = useState<AnchorStats | null>(null);
  const [recentAnchors, setRecentAnchors] = useState<RecentAnchor[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const isAdmin = PLATFORM_ADMIN_EMAILS.includes(user?.email ?? '');

  const fetchStats = useCallback(async () => {
    try {
      // Fetch anchor counts by status
      const [
        { count: totalCount },
        { count: pendingCount },
        { count: securedCount },
        { count: revokedCount },
      ] = await Promise.all([
        supabase.from('anchors').select('*', { count: 'exact', head: true }).is('deleted_at', null),
        supabase.from('anchors').select('*', { count: 'exact', head: true }).eq('status', 'PENDING').is('deleted_at', null),
        supabase.from('anchors').select('*', { count: 'exact', head: true }).eq('status', 'SECURED').is('deleted_at', null),
        supabase.from('anchors').select('*', { count: 'exact', head: true }).eq('status', 'REVOKED').is('deleted_at', null),
      ]);

      setStats({
        total: totalCount ?? 0,
        pending: pendingCount ?? 0,
        secured: securedCount ?? 0,
        revoked: revokedCount ?? 0,
      });

      // Fetch recent anchors
      const { data: recent } = await supabase
        .from('anchors')
        .select('id, public_id, filename, status, created_at, credential_type')
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(10);

      setRecentAnchors(recent ?? []);
    } catch {
      // Stats fetch failed — leave null
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) {
      fetchStats();
    } else {
      setLoading(false);
    }
  }, [isAdmin, fetchStats]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    fetchStats();
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
          <h2 className="text-xl font-semibold mb-2">{TREASURY_LABELS.UNAUTHORIZED}</h2>
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
            {TREASURY_LABELS.PAGE_TITLE}
          </h1>
          <p className="text-muted-foreground mt-1">
            {TREASURY_LABELS.PAGE_SUBTITLE}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          {TREASURY_LABELS.REFRESH}
        </Button>
      </div>

      {/* Anchor Processing Stats */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 mb-8">
        <TreasuryStatCard
          label={TREASURY_LABELS.TOTAL_ANCHORS}
          value={stats?.total}
          icon={FileText}
          loading={loading}
          variant="primary"
        />
        <TreasuryStatCard
          label={TREASURY_LABELS.PENDING_ANCHORS}
          value={stats?.pending}
          icon={Clock}
          loading={loading}
          variant="warning"
        />
        <TreasuryStatCard
          label={TREASURY_LABELS.SECURED_ANCHORS}
          value={stats?.secured}
          icon={CheckCircle}
          loading={loading}
          variant="success"
        />
        <TreasuryStatCard
          label={TREASURY_LABELS.REVOKED_ANCHORS}
          value={stats?.revoked}
          icon={XCircle}
          loading={loading}
          variant="muted"
        />
      </div>

      {/* Treasury Vault (placeholder — requires worker API) */}
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2 mb-8">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              {TREASURY_LABELS.VAULT_SECTION}
            </CardTitle>
            <Lock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{TREASURY_LABELS.VAULT_NETWORK}</span>
                <Badge variant="secondary" className="font-mono text-xs">
                  {import.meta.env.VITE_CHAIN_NETWORK ?? 'signet'}
                </Badge>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{TREASURY_LABELS.VAULT_BALANCE}</span>
                <span className="font-mono text-sm text-muted-foreground italic">
                  {TREASURY_LABELS.API_UNAVAILABLE}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{TREASURY_LABELS.UTXO_COUNT}</span>
                <span className="font-mono text-sm text-muted-foreground italic">—</span>
              </div>
              <p className="text-xs text-muted-foreground border-t pt-3 mt-2">
                {TREASURY_LABELS.VAULT_NOT_CONFIGURED}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              {TREASURY_LABELS.NETWORK_STATUS}
            </CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Worker</span>
                <Badge variant="outline" className="text-xs">
                  <Activity className="mr-1 h-3 w-3" />
                  {TREASURY_LABELS.UNKNOWN}
                </Badge>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Chain Client</span>
                <Badge variant="outline" className="text-xs">
                  {TREASURY_LABELS.UNKNOWN}
                </Badge>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Last Anchor</span>
                <span className="font-mono text-xs">
                  {recentAnchors.length > 0 && recentAnchors[0].status === 'SECURED'
                    ? new Date(recentAnchors[0].created_at).toLocaleString()
                    : '—'}
                </span>
              </div>
              <p className="text-xs text-muted-foreground border-t pt-3 mt-2">
                Worker health and chain status require a running worker with /api/health endpoint.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent Anchors */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            {TREASURY_LABELS.RECENT_ANCHORS}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={`skeleton-${i}`} className="flex items-center justify-between">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-5 w-16 rounded-full" />
                </div>
              ))}
            </div>
          ) : recentAnchors.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No anchors found.
            </p>
          ) : (
            <div className="space-y-2">
              {recentAnchors.map((anchor) => (
                <div
                  key={anchor.id}
                  className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <p className="font-medium truncate">{anchor.filename}</p>
                      <p className="text-xs text-muted-foreground">
                        {anchor.credential_type ?? 'Document'} · {new Date(anchor.created_at).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <AnchorStatusBadge status={anchor.status} />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}

interface TreasuryStatCardProps {
  label: string;
  value: number | undefined;
  icon: React.ElementType;
  loading: boolean;
  variant: 'primary' | 'success' | 'warning' | 'muted';
}

function TreasuryStatCard({ label, value, icon: Icon, loading, variant }: Readonly<TreasuryStatCardProps>) {
  const iconColorMap = {
    primary: 'text-primary',
    success: 'text-green-600',
    warning: 'text-amber-600',
    muted: 'text-muted-foreground',
  };

  return (
    <Card className="shadow-card-rest hover:shadow-card-hover transition-shadow hover:-translate-y-0.5">
      <CardContent className="pt-6">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          <Icon className={`h-4 w-4 ${iconColorMap[variant]}`} />
        </div>
        {loading ? (
          <Skeleton className="h-8 w-16" />
        ) : (
          <p className="text-2xl font-semibold">{value ?? 0}</p>
        )}
      </CardContent>
    </Card>
  );
}

function AnchorStatusBadge({ status }: Readonly<{ status: string }>) {
  switch (status) {
    case 'SECURED':
      return <Badge className="bg-green-500/10 text-green-700 border-green-500/30">Secured</Badge>;
    case 'PENDING':
      return <Badge className="bg-amber-500/10 text-amber-700 border-amber-500/30">Pending</Badge>;
    case 'REVOKED':
      return <Badge variant="secondary">Revoked</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}
