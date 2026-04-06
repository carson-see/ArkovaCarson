/**
 * Compliance Trend Dashboard Page (COMP-07)
 *
 * Displays time-series compliance KPIs with green/amber/red thresholds.
 * Designed for CISOs and compliance officers to demonstrate continuous
 * improvement to auditors.
 */

import { useState, useCallback } from 'react';
import { TrendingUp, Download, RefreshCw, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AppShell } from '@/components/layout';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { supabase } from '@/lib/supabase';
import { COMPLIANCE_TREND_LABELS } from '@/lib/copy';

interface TrendDataPoint {
  period: string;
  total_signatures: number;
  qualified_timestamp_pct: number;
  avg_anchor_delay_minutes: number;
  active_certificates: number;
  expired_certificates: number;
  total_anchors: number;
  secured_anchors: number;
}

interface TrendsResponse {
  data: TrendDataPoint[];
  thresholds: Record<string, string> | null;
  generated_at: string;
}

const THRESHOLD_COLORS: Record<string, string> = {
  green: 'text-green-500',
  amber: 'text-amber-500',
  red: 'text-destructive',
};

export function ComplianceTrendPage() {
  const { signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const [granularity, setGranularity] = useState('weekly');
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 3);
    return d.toISOString().split('T')[0];
  });
  const [toDate, setToDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<TrendsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchTrends = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setError('Not authenticated'); return; }

      const workerUrl = import.meta.env.VITE_WORKER_URL || 'http://localhost:3001';
      const params = new URLSearchParams({
        granularity,
        from: new Date(fromDate).toISOString(),
        to: new Date(toDate).toISOString(),
      });

      const resp = await fetch(`${workerUrl}/api/v1/signatures/compliance-trends?${params}`, {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: 'Request failed' }));
        setError(err.error || `HTTP ${resp.status}`);
        return;
      }

      setData(await resp.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, [granularity, fromDate, toDate]);

  const downloadCsv = useCallback(() => {
    if (!data) return;
    const header = 'period,total_anchors,secured_anchors,total_signatures,qualified_timestamp_pct,avg_anchor_delay_minutes,active_certificates,expired_certificates\n';
    const rows = data.data.map(d =>
      `${d.period},${d.total_anchors},${d.secured_anchors},${d.total_signatures},${d.qualified_timestamp_pct},${d.avg_anchor_delay_minutes},${d.active_certificates},${d.expired_certificates}`
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `compliance-trends-${fromDate}-to-${toDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [data, fromDate, toDate]);

  return (
    <AppShell
      profile={profile}
      profileLoading={profileLoading}
      onSignOut={signOut}
    >
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <TrendingUp className="h-6 w-6" /> {COMPLIANCE_TREND_LABELS.PAGE_TITLE}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">{COMPLIANCE_TREND_LABELS.PAGE_DESCRIPTION}</p>
        </div>

        {/* Controls */}
        <Card>
          <CardContent className="pt-4">
            <div className="flex flex-wrap gap-4 items-end">
              <div>
                <Label>Granularity</Label>
                <Select value={granularity} onValueChange={setGranularity}>
                  <SelectTrigger className="w-[130px] mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>From</Label>
                <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="mt-1 w-[160px]" />
              </div>
              <div>
                <Label>To</Label>
                <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="mt-1 w-[160px]" />
              </div>
              <Button onClick={fetchTrends} disabled={loading}>
                <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
                {loading ? 'Loading...' : COMPLIANCE_TREND_LABELS.FETCH}
              </Button>
            </div>
          </CardContent>
        </Card>

        {error && (
          <div className="text-sm text-destructive flex items-center gap-1">
            <AlertTriangle className="h-4 w-4" /> {error}
          </div>
        )}

        {/* Thresholds */}
        {data?.thresholds && (
          <div className="grid grid-cols-3 gap-3">
            {Object.entries(data.thresholds).map(([key, status]) => (
              <Card key={key}>
                <CardContent className="pt-4 text-center">
                  <div className={`text-lg font-bold ${THRESHOLD_COLORS[status] || ''}`}>
                    {status.toUpperCase()}
                  </div>
                  <div className="text-xs text-muted-foreground capitalize">
                    {key.replace(/_/g, ' ')}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Data Table */}
        {data && data.data.length > 0 && (
          <>
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={downloadCsv}>
                <Download className="h-4 w-4 mr-1" /> {COMPLIANCE_TREND_LABELS.DOWNLOAD_CSV}
              </Button>
            </div>
            <Card>
              <CardContent className="pt-4">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="pb-2 font-medium">Period</th>
                        <th className="pb-2 font-medium text-right">Anchors</th>
                        <th className="pb-2 font-medium text-right">Secured</th>
                        <th className="pb-2 font-medium text-right">Signatures</th>
                        <th className="pb-2 font-medium text-right">Timestamp %</th>
                        <th className="pb-2 font-medium text-right">Avg Delay (min)</th>
                        <th className="pb-2 font-medium text-right">Certs (active/expired)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.data.map(d => (
                        <tr key={d.period} className="border-b last:border-0">
                          <td className="py-2 font-medium">{d.period}</td>
                          <td className="py-2 text-right text-muted-foreground">{d.total_anchors}</td>
                          <td className="py-2 text-right text-muted-foreground">{d.secured_anchors}</td>
                          <td className="py-2 text-right text-muted-foreground">{d.total_signatures}</td>
                          <td className="py-2 text-right">
                            <span className={d.qualified_timestamp_pct >= 95 ? 'text-green-500' : d.qualified_timestamp_pct >= 80 ? 'text-amber-500' : 'text-destructive'}>
                              {d.qualified_timestamp_pct}%
                            </span>
                          </td>
                          <td className="py-2 text-right">
                            <span className={d.avg_anchor_delay_minutes <= 60 ? 'text-green-500' : d.avg_anchor_delay_minutes <= 1440 ? 'text-amber-500' : 'text-destructive'}>
                              {d.avg_anchor_delay_minutes}
                            </span>
                          </td>
                          <td className="py-2 text-right text-muted-foreground">
                            {d.active_certificates}/{d.expired_certificates}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </>
        )}

        {data && data.data.length === 0 && (
          <Card>
            <CardContent className="pt-8 pb-8 text-center text-muted-foreground">
              No data available for the selected period.
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
