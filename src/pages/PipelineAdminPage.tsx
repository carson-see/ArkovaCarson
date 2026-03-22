/**
 * Pipeline Monitoring Dashboard (PH1-DATA-05)
 *
 * Admin-only page showing data ingestion, anchoring, and embedding pipeline status.
 * Queries public_records and public_record_embeddings tables for real-time metrics.
 *
 * Platform admin only (carson@arkova.ai, sarah@arkova.ai).
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  RefreshCw,
  Database,
  Shield,
  Cpu,
  AlertCircle,
  FileText,
  Scale,
  BookOpen,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ROUTES } from '@/lib/routes';
import { PIPELINE_LABELS } from '@/lib/copy';
import { supabase } from '@/lib/supabase';

const PLATFORM_ADMIN_EMAILS = ['carson@arkova.ai', 'sarah@arkova.ai'];

interface PipelineStats {
  totalRecords: number;
  anchoredRecords: number;
  pendingRecords: number;
  embeddedRecords: number;
  bySource: Record<string, number>;
  recentErrors: number;
}

export function PipelineAdminPage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const isAdmin = PLATFORM_ADMIN_EMAILS.includes(user?.email ?? '');

  // Tables from migrations 0077-0080 not yet in generated types
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = supabase as any;

  const [stats, setStats] = useState<PipelineStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchStats = useCallback(async () => {
    try {
      // Total records
      const { count: totalRecords } = await dbAny
        .from('public_records')
        .select('*', { count: 'exact', head: true });

      // Anchored records (anchor_id not null)
      const { count: anchoredRecords } = await dbAny
        .from('public_records')
        .select('*', { count: 'exact', head: true })
        .not('anchor_id', 'is', null);

      // Pending records (anchor_id is null)
      const { count: pendingRecords } = await dbAny
        .from('public_records')
        .select('*', { count: 'exact', head: true })
        .is('anchor_id', null);

      // Embedded records
      const { count: embeddedRecords } = await dbAny
        .from('public_record_embeddings')
        .select('*', { count: 'exact', head: true });

      // Records by source
      const { data: sources } = await dbAny
        .from('public_records')
        .select('source');

      const bySource: Record<string, number> = {};
      ((sources ?? []) as Array<{ source: string }>).forEach((r) => {
        bySource[r.source] = (bySource[r.source] ?? 0) + 1;
      });

      setStats({
        totalRecords: totalRecords ?? 0,
        anchoredRecords: anchoredRecords ?? 0,
        pendingRecords: pendingRecords ?? 0,
        embeddedRecords: embeddedRecords ?? 0,
        bySource,
        recentErrors: 0,
      });
    } catch {
      // Stats fetch failed
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
                Pipeline monitoring is only available to platform administrators.
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

  const sourceIcon = (source: string) => {
    switch (source) {
      case 'edgar': return <FileText className="h-4 w-4" />;
      case 'uspto': return <Scale className="h-4 w-4" />;
      case 'federal_register': return <BookOpen className="h-4 w-4" />;
      default: return <Database className="h-4 w-4" />;
    }
  };

  const sourceLabel = (source: string) => {
    switch (source) {
      case 'edgar': return PIPELINE_LABELS.SOURCE_EDGAR;
      case 'uspto': return PIPELINE_LABELS.SOURCE_USPTO;
      case 'federal_register': return PIPELINE_LABELS.SOURCE_FEDERAL_REGISTER;
      case 'mcp': return PIPELINE_LABELS.SOURCE_MCP;
      default: return source;
    }
  };

  return (
    <AppShell user={user ?? undefined} onSignOut={signOut} profile={profile ?? undefined} profileLoading={profileLoading}>
      <div className="space-y-6 p-4 md:p-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold font-display tracking-tight">
              {PIPELINE_LABELS.PAGE_TITLE}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {PIPELINE_LABELS.PAGE_DESCRIPTION}
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

        {/* Stats Grid */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label={PIPELINE_LABELS.RECORDS_INGESTED}
            value={stats?.totalRecords}
            icon={<Database className="h-5 w-5 text-[#00d4ff]" />}
            loading={loading}
          />
          <StatCard
            label={PIPELINE_LABELS.RECORDS_ANCHORED}
            value={stats?.anchoredRecords}
            icon={<Shield className="h-5 w-5 text-emerald-400" />}
            loading={loading}
          />
          <StatCard
            label={PIPELINE_LABELS.RECORDS_PENDING}
            value={stats?.pendingRecords}
            icon={<AlertCircle className="h-5 w-5 text-amber-400" />}
            loading={loading}
          />
          <StatCard
            label={PIPELINE_LABELS.RECORDS_EMBEDDED}
            value={stats?.embeddedRecords}
            icon={<Cpu className="h-5 w-5 text-purple-400" />}
            loading={loading}
          />
        </div>

        {/* Source Breakdown */}
        <Card className="border-[#00d4ff]/10 bg-transparent">
          <CardHeader>
            <CardTitle className="text-base">Records by Source</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-full" />)}
              </div>
            ) : (
              <div className="space-y-3">
                {Object.entries(stats?.bySource ?? {})
                  .sort(([, a], [, b]) => b - a)
                  .map(([source, count]) => (
                    <div key={source} className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                      <div className="flex items-center gap-3">
                        {sourceIcon(source)}
                        <span className="text-sm font-medium">{sourceLabel(source)}</span>
                      </div>
                      <Badge variant="secondary" className="font-mono">
                        {count.toLocaleString()}
                      </Badge>
                    </div>
                  ))}
                {Object.keys(stats?.bySource ?? {}).length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No records ingested yet. Run the data pipeline to start.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Anchoring Rate */}
        <Card className="border-[#00d4ff]/10 bg-transparent">
          <CardHeader>
            <CardTitle className="text-base">Anchoring Progress</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-4 w-full" />
            ) : (
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Anchored / Total</span>
                  <span className="font-mono">
                    {(stats?.anchoredRecords ?? 0).toLocaleString()} / {(stats?.totalRecords ?? 0).toLocaleString()}
                  </span>
                </div>
                <div className="w-full bg-muted rounded-full h-2">
                  <div
                    className="bg-[#00d4ff] h-2 rounded-full transition-all"
                    style={{
                      width: `${stats?.totalRecords ? Math.round(((stats?.anchoredRecords ?? 0) / stats.totalRecords) * 100) : 0}%`,
                    }}
                  />
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Embedded / Total</span>
                  <span className="font-mono">
                    {(stats?.embeddedRecords ?? 0).toLocaleString()} / {(stats?.totalRecords ?? 0).toLocaleString()}
                  </span>
                </div>
                <div className="w-full bg-muted rounded-full h-2">
                  <div
                    className="bg-purple-400 h-2 rounded-full transition-all"
                    style={{
                      width: `${stats?.totalRecords ? Math.round(((stats?.embeddedRecords ?? 0) / stats.totalRecords) * 100) : 0}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

/** Stat card matching Synthetic Sentinel style */
function StatCard({
  label,
  value,
  icon,
  loading,
}: {
  label: string;
  value: number | undefined;
  icon: React.ReactNode;
  loading: boolean;
}) {
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
          <p className="text-2xl font-bold font-mono">
            {(value ?? 0).toLocaleString()}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
