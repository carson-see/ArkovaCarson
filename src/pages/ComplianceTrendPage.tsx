/**
 * Compliance Trend Dashboard (COMP-07)
 *
 * Time-series compliance KPIs with threshold indicators.
 * Accessible from compliance center sidebar.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  TrendingUp,
  ShieldCheck,
  Download,
  AlertTriangle,
  CheckCircle,
  XCircle,
} from 'lucide-react';
import { AppShell } from '@/components/layout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { usePageMeta } from '@/hooks/usePageMeta';
import { COMPLIANCE_TREND_LABELS } from '@/lib/copy';

const L = COMPLIANCE_TREND_LABELS;

interface TrendBucket {
  period: string;
  anchors: number;
  secured: number;
  signatures: number;
  timestamp_coverage_pct: number | null;
  ltv_coverage_pct: number | null;
  avg_anchor_delay_min: number | null;
}

interface CertHealth {
  active: number;
  expiring_soon: number;
  expired: number;
  revoked: number;
}

interface TrendData {
  granularity: string;
  time_series: TrendBucket[];
  certificate_health: CertHealth;
  thresholds: Record<string, string>;
}

function ThresholdBadge({ level }: { level: string }) {
  if (level === 'green') return <Badge variant="outline" className="border-green-500 text-green-600"><CheckCircle className="h-3 w-3 mr-1" />{L.THRESHOLD_GREEN}</Badge>;
  if (level === 'amber') return <Badge variant="outline" className="border-amber-500 text-amber-600"><AlertTriangle className="h-3 w-3 mr-1" />{L.THRESHOLD_AMBER}</Badge>;
  if (level === 'red') return <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />{L.THRESHOLD_RED}</Badge>;
  return <Badge variant="secondary">N/A</Badge>;
}

export function ComplianceTrendPage() {
  usePageMeta({ title: L.PAGE_TITLE + ' — Arkova', description: L.PAGE_DESCRIPTION });

  const { session, user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const [data, setData] = useState<TrendData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [granularity, setGranularity] = useState<'daily' | 'weekly' | 'monthly'>('weekly');

  const fetchTrends = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true);
    setError(null);
    try {
      const now = new Date();
      const threeMonthsAgo = new Date(now.getTime() - 90 * 86400_000);
      const workerUrl = import.meta.env.VITE_WORKER_URL || '';
      const params = new URLSearchParams({
        granularity,
        from: threeMonthsAgo.toISOString(),
        to: now.toISOString(),
      });
      const res = await fetch(`${workerUrl}/api/v1/compliance/trends?${params}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        setError(L.ERROR);
        return;
      }
      setData(await res.json());
    } catch {
      setError(L.ERROR);
    } finally {
      setLoading(false);
    }
  }, [session?.access_token, granularity]);

  useEffect(() => { fetchTrends(); }, [fetchTrends]);

  const handleExportCsv = () => {
    if (!data) return;
    const header = 'Period,Anchors,Secured,Signatures,Timestamp Coverage %,LTV Coverage %,Avg Delay (min)\n';
    const rows = data.time_series.map(b =>
      `${b.period},${b.anchors},${b.secured},${b.signatures},${b.timestamp_coverage_pct ?? ''},${b.ltv_coverage_pct ?? ''},${b.avg_anchor_delay_min ?? ''}`
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `compliance-trends-${granularity}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <AppShell user={user ?? undefined} onSignOut={signOut} profile={profile ?? undefined} profileLoading={profileLoading}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <TrendingUp className="h-6 w-6 text-primary" />
              {L.PAGE_TITLE}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">{L.PAGE_DESCRIPTION}</p>
          </div>
          <div className="flex items-center gap-2">
            {(['daily', 'weekly', 'monthly'] as const).map(g => (
              <Button
                key={g}
                variant={granularity === g ? 'default' : 'outline'}
                size="sm"
                onClick={() => setGranularity(g)}
              >
                {g === 'daily' ? L.GRANULARITY_DAILY : g === 'weekly' ? L.GRANULARITY_WEEKLY : L.GRANULARITY_MONTHLY}
              </Button>
            ))}
          </div>
        </div>

        {loading && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i}><CardContent className="pt-6"><Skeleton className="h-16 w-full" /></CardContent></Card>
            ))}
          </div>
        )}

        {error && !loading && (
          <Card className="border-destructive">
            <CardContent className="pt-6 text-center text-destructive">{error}</CardContent>
          </Card>
        )}

        {!loading && !error && data && (
          <>
            {/* Threshold Summary */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{L.KPI_TIMESTAMP_COVERAGE}</CardTitle></CardHeader>
                <CardContent><ThresholdBadge level={data.thresholds.timestamp_coverage} /></CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{L.KPI_LTV_COVERAGE}</CardTitle></CardHeader>
                <CardContent><ThresholdBadge level={data.thresholds.ltv_coverage} /></CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{L.KPI_ANCHOR_DELAY}</CardTitle></CardHeader>
                <CardContent><ThresholdBadge level={data.thresholds.anchor_delay} /></CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{L.CERT_HEALTH_TITLE}</CardTitle></CardHeader>
                <CardContent><ThresholdBadge level={data.thresholds.cert_health} /></CardContent>
              </Card>
            </div>

            {/* Time Series Table */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>{L.PAGE_TITLE}</CardTitle>
                <Button variant="outline" size="sm" onClick={handleExportCsv}>
                  <Download className="h-3.5 w-3.5 mr-1.5" />{L.EXPORT_CSV}
                </Button>
              </CardHeader>
              <CardContent>
                {data.time_series.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">{L.NO_DATA}</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left py-2 pr-4 font-medium text-muted-foreground">Period</th>
                          <th className="text-right py-2 px-2 font-medium text-muted-foreground">{L.KPI_ANCHORS}</th>
                          <th className="text-right py-2 px-2 font-medium text-muted-foreground">{L.KPI_SIGNATURES}</th>
                          <th className="text-right py-2 px-2 font-medium text-muted-foreground hidden sm:table-cell">{L.KPI_TIMESTAMP_COVERAGE}</th>
                          <th className="text-right py-2 px-2 font-medium text-muted-foreground hidden md:table-cell">{L.KPI_LTV_COVERAGE}</th>
                          <th className="text-right py-2 pl-2 font-medium text-muted-foreground hidden lg:table-cell">{L.KPI_ANCHOR_DELAY}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.time_series.map(b => (
                          <tr key={b.period} className="border-b last:border-0">
                            <td className="py-2 pr-4 font-medium">{b.period}</td>
                            <td className="py-2 px-2 text-right">{b.anchors}</td>
                            <td className="py-2 px-2 text-right">{b.signatures}</td>
                            <td className="py-2 px-2 text-right hidden sm:table-cell">{b.timestamp_coverage_pct != null ? `${b.timestamp_coverage_pct}%` : '—'}</td>
                            <td className="py-2 px-2 text-right hidden md:table-cell">{b.ltv_coverage_pct != null ? `${b.ltv_coverage_pct}%` : '—'}</td>
                            <td className="py-2 pl-2 text-right hidden lg:table-cell">{b.avg_anchor_delay_min != null ? `${b.avg_anchor_delay_min}m` : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Certificate Health */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5 text-primary" />
                  {L.CERT_HEALTH_TITLE}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
                  <div>
                    <p className="text-2xl font-bold text-green-600">{data.certificate_health.active}</p>
                    <p className="text-xs text-muted-foreground">{L.CERT_ACTIVE}</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-amber-500">{data.certificate_health.expiring_soon}</p>
                    <p className="text-xs text-muted-foreground">{L.CERT_EXPIRING}</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-red-500">{data.certificate_health.expired}</p>
                    <p className="text-xs text-muted-foreground">{L.CERT_EXPIRED}</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-muted-foreground">{data.certificate_health.revoked}</p>
                    <p className="text-xs text-muted-foreground">{L.CERT_REVOKED}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}
