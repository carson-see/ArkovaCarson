/**
 * Payment Analytics Dashboard (PH1-PAY-03)
 *
 * Admin-only page showing x402 payment revenue, per-endpoint breakdown,
 * and settlement tracking. Queries x402_payments table.
 *
 * Platform admin only (carson@arkova.ai, sarah@arkova.ai).
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  RefreshCw,
  DollarSign,
  TrendingUp,
  Zap,
  AlertCircle,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ROUTES } from '@/lib/routes';
import { PAYMENT_LABELS } from '@/lib/copy';
import { supabase } from '@/lib/supabase';

import { isPlatformAdmin } from '@/lib/platform';

interface PaymentStats {
  totalRevenue: number;
  paymentsToday: number;
  paymentsWeek: number;
  paymentsMonth: number;
  averagePayment: number;
  byEndpoint: Record<string, { count: number; revenue: number }>;
  recentPayments: Array<{
    id: string;
    amount_usd: number;
    payer_address: string;
    created_at: string;
    network: string;
  }>;
}

export function PaymentAnalyticsPage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const isAdmin = isPlatformAdmin(user?.email);

  const [stats, setStats] = useState<PaymentStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchStats = useCallback(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dbAny = supabase as any;

      // All payments (x402_payments from migration 0080)
      // Capped at 1000 most recent to prevent unbounded memory usage
      const { data: payments } = await dbAny
        .from('x402_payments')
        .select('id, amount_usd, payer_address, payee_address, network, created_at, verification_request_id')
        .order('created_at', { ascending: false })
        .limit(1000);

      const allPayments = payments ?? [];

      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const weekStart = new Date(now.getTime() - 7 * 86400000).toISOString();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

      const totalRevenue = allPayments.reduce((sum: number, p: { amount_usd: number }) => sum + (p.amount_usd ?? 0), 0);
      const paymentsToday = allPayments.filter((p: { created_at: string }) => p.created_at >= todayStart).length;
      const paymentsWeek = allPayments.filter((p: { created_at: string }) => p.created_at >= weekStart).length;
      const paymentsMonth = allPayments.filter((p: { created_at: string }) => p.created_at >= monthStart).length;
      const averagePayment = allPayments.length > 0 ? totalRevenue / allPayments.length : 0;

      // Group by endpoint (using verification_request_id pattern)
      const byEndpoint: Record<string, { count: number; revenue: number }> = {};
      allPayments.forEach((p: { verification_request_id: string | null; amount_usd: number }) => {
        const endpoint = p.verification_request_id?.startsWith('verify') ? '/api/v1/verify' :
          p.verification_request_id?.startsWith('nessie') ? '/api/v1/nessie/query' :
          p.verification_request_id?.startsWith('search') ? '/api/v1/ai/search' :
          '/api/v1/other';
        if (!byEndpoint[endpoint]) byEndpoint[endpoint] = { count: 0, revenue: 0 };
        byEndpoint[endpoint].count += 1;
        byEndpoint[endpoint].revenue += p.amount_usd ?? 0;
      });

      setStats({
        totalRevenue,
        paymentsToday,
        paymentsWeek,
        paymentsMonth,
        averagePayment,
        byEndpoint,
        recentPayments: allPayments.slice(0, 20).map((p: { id: string; amount_usd: number; payer_address: string; created_at: string; network: string }) => ({
          id: p.id,
          amount_usd: p.amount_usd,
          payer_address: p.payer_address,
          created_at: p.created_at,
          network: p.network,
        })),
      });
    } catch {
      // Stats fetch failed
    } finally {
      setLoading(false);
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
    fetchStats().finally(() => setRefreshing(false));
  }, [fetchStats]);

  if (!isAdmin) {
    return (
      <AppShell user={user ?? undefined} onSignOut={signOut} profile={profile ?? undefined} profileLoading={profileLoading}>
        <div className="flex items-center justify-center min-h-[60vh]">
          <Card className="border-[#00d4ff]/10 bg-transparent max-w-md">
            <CardContent className="pt-6 text-center">
              <AlertCircle className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
              <h2 className="text-lg font-semibold mb-2">Access Restricted</h2>
              <p className="text-sm text-muted-foreground mb-4">
                Payment analytics is only available to platform administrators.
              </p>
              <Button variant="outline" onClick={() => navigate(ROUTES.DASHBOARD)}>
                Return to Dashboard
              </Button>
            </CardContent>
          </Card>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell user={user ?? undefined} onSignOut={signOut} profile={profile ?? undefined} profileLoading={profileLoading}>
      <div className="space-y-6 p-4 md:p-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold font-display tracking-tight">
              {PAYMENT_LABELS.PAGE_TITLE}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {PAYMENT_LABELS.PAGE_DESCRIPTION}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
            className="border-[#00d4ff]/20"
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {/* Revenue Stats */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <RevenueCard
            label={PAYMENT_LABELS.TOTAL_REVENUE}
            value={stats?.totalRevenue}
            icon={<DollarSign className="h-5 w-5 text-emerald-400" />}
            loading={loading}
            format="currency"
          />
          <RevenueCard
            label={PAYMENT_LABELS.PAYMENTS_TODAY}
            value={stats?.paymentsToday}
            icon={<Zap className="h-5 w-5 text-[#00d4ff]" />}
            loading={loading}
          />
          <RevenueCard
            label={PAYMENT_LABELS.PAYMENTS_MONTH}
            value={stats?.paymentsMonth}
            icon={<TrendingUp className="h-5 w-5 text-purple-400" />}
            loading={loading}
          />
          <RevenueCard
            label={PAYMENT_LABELS.AVERAGE_PAYMENT}
            value={stats?.averagePayment}
            icon={<DollarSign className="h-5 w-5 text-amber-400" />}
            loading={loading}
            format="currency"
          />
        </div>

        {/* Revenue by Endpoint */}
        <Card className="border-[#00d4ff]/10 bg-transparent">
          <CardHeader>
            <CardTitle className="text-base">{PAYMENT_LABELS.TOP_ENDPOINTS}</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-full" />)}
              </div>
            ) : (
              <div className="space-y-3">
                {Object.entries(stats?.byEndpoint ?? {})
                  .sort(([, a], [, b]) => b.revenue - a.revenue)
                  .map(([endpoint, data]) => (
                    <div key={endpoint} className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                      <span className="text-sm font-mono text-muted-foreground">{endpoint}</span>
                      <div className="flex items-center gap-3">
                        <Badge variant="secondary" className="font-mono">
                          {data.count} calls
                        </Badge>
                        <span className="text-sm font-mono font-semibold text-emerald-400">
                          ${data.revenue.toFixed(4)}
                        </span>
                      </div>
                    </div>
                  ))}
                {Object.keys(stats?.byEndpoint ?? {}).length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No x402 payments recorded yet.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent Payments */}
        <Card className="border-[#00d4ff]/10 bg-transparent">
          <CardHeader>
            <CardTitle className="text-base">Recent Payments</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-full" />)}
              </div>
            ) : (
              <div className="space-y-2">
                {(stats?.recentPayments ?? []).map((payment) => (
                  <div key={payment.id} className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                    <div className="flex flex-col">
                      <span className="text-xs font-mono text-muted-foreground">
                        {payment.payer_address.slice(0, 10)}...{payment.payer_address.slice(-6)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(payment.created_at).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">{payment.network}</Badge>
                      <span className="text-sm font-mono font-semibold text-emerald-400">
                        ${payment.amount_usd.toFixed(4)}
                      </span>
                    </div>
                  </div>
                ))}
                {(stats?.recentPayments ?? []).length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No payments yet.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

function RevenueCard({
  label,
  value,
  icon,
  loading,
  format,
}: {
  label: string;
  value: number | undefined;
  icon: React.ReactNode;
  loading: boolean;
  format?: 'currency';
}) {
  const displayValue = format === 'currency'
    ? `$${(value ?? 0).toFixed(4)}`
    : (value ?? 0).toLocaleString();

  return (
    <Card className="border-[#00d4ff]/10 bg-transparent">
      <CardContent className="pt-6">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-muted-foreground">{label}</span>
          {icon}
        </div>
        {loading ? (
          <Skeleton className="h-8 w-20" />
        ) : (
          <p className="text-2xl font-bold font-mono">{displayValue}</p>
        )}
      </CardContent>
    </Card>
  );
}
