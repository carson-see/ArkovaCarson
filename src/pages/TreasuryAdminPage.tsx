/**
 * Treasury Admin Dashboard
 *
 * Internal-only ops page for Arkova platform administrators.
 * Shows worker-sourced treasury balance/cache freshness, recent network
 * receipts, fee rates + averages, and cost estimates.
 *
 * CRITICAL: This page is ONLY accessible to select Arkova organization members.
 * Third-party org admins and external users must NEVER see treasury data.
 *
 * @see feedback_treasury_access
 * @see GAP-01
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, AlertTriangle } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useTreasuryBalance } from '@/hooks/useTreasuryBalance';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ROUTES } from '@/lib/routes';
import { TREASURY_LABELS, DATA_ERROR_LABELS } from '@/lib/copy';
import { isPlatformAdmin } from '@/lib/platform';
import { workerFetch } from '@/lib/workerClient';
import { BalanceCard, AnchorStats as AnchorStatsPanel, ReceiptTable, NetworkInfo } from '@/components/admin/treasury';
import { DataErrorBanner } from '@/components/DataErrorBanner';

function formatTreasuryFreshness(updatedAt: string | null): string {
  if (!updatedAt) return 'No treasury cache timestamp returned';
  const updatedMs = new Date(updatedAt).getTime();
  if (!Number.isFinite(updatedMs)) return 'Treasury cache timestamp unavailable';
  const ageMinutes = Math.floor(Math.max(Date.now() - updatedMs, 0) / 60_000);
  if (ageMinutes < 1) return 'Treasury cache refreshed less than a minute ago';
  if (ageMinutes === 1) return 'Treasury cache refreshed 1 minute ago';
  return `Treasury cache refreshed ${ageMinutes.toLocaleString()} minutes ago`;
}

export function TreasuryAdminPage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const { balance, receipts, feeRates, anchorStats, sourceState, loading, error: balanceError, refresh: refreshBalance } = useTreasuryBalance();

  const [refreshing, setRefreshing] = useState(false);

  const isAdmin = isPlatformAdmin(user?.email);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    refreshBalance().finally(() => {
      setRefreshing(false);
    });
  }, [refreshBalance]);

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

      {/* Error banner */}
      {balanceError && (
        <DataErrorBanner
          data-testid="treasury-balance-error"
          title={DATA_ERROR_LABELS.TREASURY_UNAVAILABLE_TITLE}
          message={balanceError}
          spacing="mb-3"
          onRetry={handleRefresh}
          retrying={refreshing}
        />
      )}

      {sourceState.healthError && (
        <DataErrorBanner
          data-testid="treasury-cache-error"
          title={DATA_ERROR_LABELS.TREASURY_UNAVAILABLE_TITLE}
          message={`Worker/cache freshness unavailable: ${sourceState.healthError}`}
          spacing="mb-3"
          onRetry={handleRefresh}
          retrying={refreshing}
        />
      )}

      <div
        data-testid="treasury-cache-freshness"
        className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
      >
        <Badge variant="outline" className="font-mono text-[10px]">Worker source</Badge>
        <span>{formatTreasuryFreshness(sourceState.cacheUpdatedAt)}</span>
        {sourceState.cacheStale && (
          <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/20 text-[10px]">Stale</Badge>
        )}
      </div>

      {/* Balance + Anchor Stats */}
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2 mb-8">
        <BalanceCard balance={balance} loading={loading} />
        <AnchorStatsPanel stats={anchorStats} loading={loading} />
      </div>

      {/* Network Info + Fee Rates */}
      <div className="mb-8">
        <NetworkInfo feeRates={feeRates} balance={balance} loading={loading} />
      </div>

      {/* x402 USDC Revenue (PH1-PAY-02) */}
      <Card className="mb-8">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">x402 Payment Revenue</CardTitle>
          <Badge variant="secondary" className="text-[10px]">Base Sepolia</Badge>
        </CardHeader>
        <CardContent>
          <X402PaymentStats />
        </CardContent>
      </Card>

      {/* Recent Network Receipts */}
      <ReceiptTable receipts={receipts} loading={loading} />
    </AppShell>
  );
}

/** x402 payment stats from the worker treasury endpoint */
function X402PaymentStats() {
  const [stats, setStats] = useState<{ total: number; revenue: number; recent: Array<{ tx_hash: string; amount_usd: number; created_at: string }> } | null>(null);
  const [loading, setLoading] = useState(true);
  // SCRUM-1260 (R1-6): kill silent 0/0/0. Previously the catch + error
  // branches both fell back to `{ total: 0, revenue: 0, recent: [] }`,
  // making "RPC failed" indistinguishable from "no payments yet."
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    workerFetch('/api/treasury/x402-stats', { method: 'GET' }).then(async (response) => {
      if (cancelled) return;
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        throw new Error(typeof detail?.error === 'string' ? detail.error : `Worker returned ${response.status}`);
      }
      return response.json() as Promise<{ total: number; revenue: number; recent: Array<{ tx_hash: string; amount_usd: number; created_at: string }> }>;
    }).then((data) => {
      if (cancelled) return;
      if (!data) {
        setError('No data returned');
        return;
      }
      setStats(data);
    }).catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : 'Failed to load x402 stats');
    }).finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, []);

  if (loading) return <Skeleton className="h-20 w-full" />;
  if (error) {
    return (
      <DataErrorBanner
        data-testid="x402-stats-error"
        title={DATA_ERROR_LABELS.X402_UNAVAILABLE_TITLE}
        message={error}
      />
    );
  }
  if (!stats || stats.total === 0) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">USDC Address</span>
          <span className="font-mono text-xs">0xae1201D68cE24fC6...75ba04</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Payments</span>
          <span className="font-mono text-sm">0</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Status</span>
          <Badge variant="outline" className="text-xs bg-green-500/10 text-green-700 border-green-500/30">Active</Badge>
        </div>
        <p className="text-xs text-muted-foreground border-t pt-3 mt-2">
          x402 payment gate is enabled. Unauthenticated API calls return 402 with USDC payment requirements.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Total Payments</span>
        <span className="font-mono text-sm font-semibold">{stats.total}</span>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Revenue (USDC)</span>
        <span className="font-mono text-sm font-semibold">${stats.revenue.toFixed(4)}</span>
      </div>
      {stats.recent.length > 0 && (
        <div className="border-t pt-3 mt-2 space-y-2">
          <p className="text-xs text-muted-foreground">Recent payments:</p>
          {stats.recent.map((p) => (
            <div key={p.tx_hash} className="flex items-center justify-between text-xs">
              <span className="font-mono truncate max-w-[140px]">{p.tx_hash.slice(0, 12)}…</span>
              <span className="font-mono">${p.amount_usd.toFixed(4)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
