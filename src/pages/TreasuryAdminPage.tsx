/**
 * Treasury Admin Dashboard
 *
 * Internal-only ops page for Arkova platform administrators.
 * Shows live BTC balance from mempool.space, anchor stats from Supabase,
 * recent network receipts, fee rates + averages, and cost estimates.
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
import { useAnchorStats } from '@/hooks/useAnchorStats';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ROUTES } from '@/lib/routes';
import { TREASURY_LABELS } from '@/lib/copy';
import { isPlatformAdmin } from '@/lib/platform';
import { supabase } from '@/lib/supabase';
import { BalanceCard, AnchorStats as AnchorStatsPanel, ReceiptTable, NetworkInfo } from '@/components/admin/treasury';

export function TreasuryAdminPage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const { balance, receipts, feeRates, loading: balanceLoading, error: balanceError, refresh: refreshBalance } = useTreasuryBalance();
  const { stats: anchorStats, loading: statsLoading, refresh: refreshStats } = useAnchorStats();

  const [refreshing, setRefreshing] = useState(false);

  const isAdmin = isPlatformAdmin(user?.email);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    Promise.all([refreshBalance(), refreshStats()]).finally(() => {
      setRefreshing(false);
    });
  }, [refreshBalance, refreshStats]);

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

  const loading = balanceLoading || statsLoading;

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
        <div className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700">
          <AlertTriangle className="inline h-4 w-4 mr-2" />
          {balanceError}
        </div>
      )}

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

/** x402 payment stats from x402_payments table */
function X402PaymentStats() {
  const [stats, setStats] = useState<{ total: number; revenue: number; recent: Array<{ tx_hash: string; amount_usd: number; payer_address: string; created_at: string }> } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Single RPC replaces 3 separate x402_payments queries
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbAny = supabase as any;
    dbAny.rpc('get_treasury_stats').then(({ data, error }: { data: { total_payments: number; total_revenue_usd: number; recent_payments: Array<{ tx_hash: string; amount_usd: number; payer_address: string; created_at: string }> } | null; error: unknown }) => {
      if (!error && data) {
        setStats({
          total: data.total_payments ?? 0,
          revenue: data.total_revenue_usd ?? 0,
          recent: data.recent_payments ?? [],
        });
      } else {
        setStats({ total: 0, revenue: 0, recent: [] });
      }
    }).catch(() => {
      setStats({ total: 0, revenue: 0, recent: [] });
    }).finally(() => setLoading(false));
  }, []);

  if (loading) return <Skeleton className="h-20 w-full" />;
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
              <span className="font-mono truncate max-w-[140px]">{p.payer_address}</span>
              <span className="font-mono">${p.amount_usd.toFixed(4)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
