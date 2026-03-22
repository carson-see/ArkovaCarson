/**
 * Treasury Admin Dashboard
 *
 * Internal-only ops page for Arkova platform administrators.
 * Shows real wallet balance, UTXO count, fee estimates, network info,
 * and anchor processing stats via the worker API.
 *
 * CRITICAL: This page is ONLY accessible to select Arkova organization members.
 * Third-party org admins and external users must NEVER see treasury data.
 *
 * @see feedback_treasury_access
 * @see GAP-01
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  RefreshCw,
  Clock,
  CheckCircle,
  Lock,
  Activity,
  Server,
  AlertTriangle,
  FileText,
  Zap,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useTreasuryStatus } from '@/hooks/useTreasuryStatus';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ROUTES } from '@/lib/routes';
import { TREASURY_LABELS } from '@/lib/copy';
import { supabase } from '@/lib/supabase';

import { isPlatformAdmin } from '@/lib/platform';

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
  const { status: treasuryStatus, loading: treasuryLoading, error: treasuryError, fetchStatus } = useTreasuryStatus();

  const [recentAnchors, setRecentAnchors] = useState<RecentAnchor[]>([]);
  const [anchorsLoading, setAnchorsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const isAdmin = isPlatformAdmin(user?.email);

  const fetchRecentAnchors = useCallback(async () => {
    try {
      const { data: recent } = await supabase
        .from('anchors')
        .select('id, public_id, filename, status, created_at, credential_type')
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(10);

      setRecentAnchors(recent ?? []);
    } catch {
      // Anchor fetch failed — leave empty
    } finally {
      setAnchorsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) {
      fetchStatus();
      fetchRecentAnchors();
    } else {
      setAnchorsLoading(false);
    }
  }, [isAdmin, fetchStatus, fetchRecentAnchors]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    Promise.all([fetchStatus(), fetchRecentAnchors()]).finally(() => {
      setRefreshing(false);
    });
  }, [fetchStatus, fetchRecentAnchors]);

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

  const loading = treasuryLoading || anchorsLoading;
  const wallet = treasuryStatus?.wallet;
  const network = treasuryStatus?.network;
  const fees = treasuryStatus?.fees;
  const anchorStats = treasuryStatus?.recentAnchors;

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

      {/* Error banner */}
      {treasuryError && (
        <div className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700">
          <AlertTriangle className="inline h-4 w-4 mr-2" />
          {treasuryError}
        </div>
      )}

      {/* Anchor Processing Stats */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 mb-8">
        <TreasuryStatCard
          label={TREASURY_LABELS.TOTAL_ANCHORS}
          value={anchorStats ? anchorStats.totalSecured + anchorStats.totalPending : undefined}
          icon={FileText}
          loading={loading}
          variant="primary"
        />
        <TreasuryStatCard
          label={TREASURY_LABELS.PENDING_ANCHORS}
          value={anchorStats?.totalPending}
          icon={Clock}
          loading={loading}
          variant="warning"
        />
        <TreasuryStatCard
          label={TREASURY_LABELS.SECURED_ANCHORS}
          value={anchorStats?.totalSecured}
          icon={CheckCircle}
          loading={loading}
          variant="success"
        />
        <TreasuryStatCard
          label={TREASURY_LABELS.LAST_24H}
          value={anchorStats?.last24hCount}
          icon={Activity}
          loading={loading}
          variant="primary"
        />
      </div>

      {/* Treasury Vault + Network Status */}
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2 mb-8">
        {/* Vault Card */}
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
                  {network?.name ?? 'signet'}
                </Badge>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{TREASURY_LABELS.VAULT_ADDRESS}</span>
                {loading ? (
                  <Skeleton className="h-4 w-40" />
                ) : wallet ? (
                  <span className="font-mono text-xs truncate max-w-[200px]" title={wallet.address}>
                    {wallet.address}
                  </span>
                ) : (
                  <span className="font-mono text-sm text-muted-foreground italic">—</span>
                )}
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{TREASURY_LABELS.VAULT_BALANCE}</span>
                {loading ? (
                  <Skeleton className="h-4 w-20" />
                ) : wallet ? (
                  <span className="font-mono text-sm font-semibold">
                    {wallet.balanceSats.toLocaleString()} sats
                  </span>
                ) : (
                  <span className="font-mono text-sm text-muted-foreground italic">
                    {TREASURY_LABELS.API_UNAVAILABLE}
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{TREASURY_LABELS.UTXO_COUNT}</span>
                {loading ? (
                  <Skeleton className="h-4 w-12" />
                ) : wallet ? (
                  <span className="font-mono text-sm">{wallet.utxoCount}</span>
                ) : (
                  <span className="font-mono text-sm text-muted-foreground italic">—</span>
                )}
              </div>
              {!wallet && !loading && (
                <p className="text-xs text-muted-foreground border-t pt-3 mt-2">
                  {treasuryStatus?.error ?? TREASURY_LABELS.VAULT_NOT_CONFIGURED}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Network + Fee Card */}
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
                <span className="text-muted-foreground">{TREASURY_LABELS.WORKER_STATUS}</span>
                {loading ? (
                  <Skeleton className="h-5 w-20" />
                ) : treasuryStatus ? (
                  <Badge variant="outline" className="text-xs bg-green-500/10 text-green-700 border-green-500/30">
                    <Activity className="mr-1 h-3 w-3" />
                    {TREASURY_LABELS.CONNECTED}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-xs">
                    {TREASURY_LABELS.UNKNOWN}
                  </Badge>
                )}
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{TREASURY_LABELS.BLOCK_HEIGHT}</span>
                {loading ? (
                  <Skeleton className="h-4 w-20" />
                ) : network ? (
                  <span className="font-mono text-xs">{network.blockHeight.toLocaleString()}</span>
                ) : (
                  <span className="font-mono text-xs text-muted-foreground">—</span>
                )}
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{TREASURY_LABELS.FEE_RATE}</span>
                {loading ? (
                  <Skeleton className="h-4 w-16" />
                ) : fees ? (
                  <span className="font-mono text-xs flex items-center gap-1">
                    <Zap className="h-3 w-3 text-amber-500" />
                    {fees.currentRateSatPerVbyte} sat/vB
                  </span>
                ) : (
                  <span className="font-mono text-xs text-muted-foreground">—</span>
                )}
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Last Secured Anchor</span>
                <span className="font-mono text-xs">
                  {anchorStats?.lastSecuredAt
                    ? new Date(anchorStats.lastSecuredAt).toLocaleString()
                    : '—'}
                </span>
              </div>
              {fees && (
                <p className="text-xs text-muted-foreground border-t pt-3 mt-2">
                  Fee estimated via {fees.estimatorName}. Network: {network?.name ?? 'unknown'}.
                </p>
              )}
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
          {anchorsLoading ? (
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
