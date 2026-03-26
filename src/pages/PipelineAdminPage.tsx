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
  GraduationCap,
  Loader2,
  Search,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  X,
  Copy,
  Check,
  Link2,
  Layers,
  Building2,
  Heart,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { workerFetch } from '@/lib/workerClient';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ROUTES } from '@/lib/routes';
import { PIPELINE_LABELS } from '@/lib/copy';
import { supabase } from '@/lib/supabase';

import { isPlatformAdmin, mempoolTxUrl, mempoolAddressUrl } from '@/lib/platform';

interface PipelineStats {
  totalRecords: number;
  anchoredRecords: number;
  pendingRecords: number;
  embeddedRecords: number;
  bySource: Record<string, number>;
  recentErrors: number;
}

interface PublicRecord {
  id: string;
  source: string;
  source_id: string;
  source_url: string | null;
  record_type: string;
  title: string | null;
  content_hash: string;
  anchor_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface AnchorDetails {
  id: string;
  fingerprint: string;
  status: string;
  chain_tx_id: string | null;
  chain_block_height: number | null;
  chain_timestamp: string | null;
  public_id: string;
  credential_type: string | null;
  created_at: string;
}

interface RecordFilters {
  source: string;
  recordType: string;
  anchorStatus: string;
  search: string;
}

const PAGE_SIZE = 25;

export function PipelineAdminPage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const isAdmin = isPlatformAdmin(user?.email);

  // Tables from migrations 0077-0080 not yet in generated types
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = supabase as any;

  const [stats, setStats] = useState<PipelineStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchStats = useCallback(async () => {
    try {
      // Try RPC first (migration 0106) — single call for all stats
      const { data: pipelineStats, error: rpcError } = await dbAny.rpc('get_pipeline_stats');

      let totalRecords = 0;
      let anchoredRecords = 0;
      let pendingRecords = 0;
      let embeddedRecords = 0;

      if (!rpcError && pipelineStats) {
        totalRecords = pipelineStats.total_records ?? 0;
        anchoredRecords = pipelineStats.anchored_records ?? 0;
        pendingRecords = pipelineStats.pending_records ?? 0;
        embeddedRecords = pipelineStats.embedded_records ?? 0;
      } else {
        // Fallback: direct count queries when RPC function doesn't exist
        const { count: total } = await dbAny.from('public_records').select('*', { count: 'exact', head: true });
        const { count: anchored } = await dbAny.from('public_records').select('*', { count: 'exact', head: true }).not('anchor_id', 'is', null);
        const { count: pending } = await dbAny.from('public_records').select('*', { count: 'exact', head: true }).is('anchor_id', null);
        const { count: embedded } = await dbAny.from('public_record_embeddings').select('*', { count: 'exact', head: true });
        totalRecords = total ?? 0;
        anchoredRecords = anchored ?? 0;
        pendingRecords = pending ?? 0;
        embeddedRecords = embedded ?? 0;
      }

      // Records by source — use RPC to avoid PostgREST row limit (was only returning 1000)
      const { data: sourceCounts } = await dbAny.rpc('count_public_records_by_source');
      const bySource: Record<string, number> = {};
      if (sourceCounts && Array.isArray(sourceCounts)) {
        (sourceCounts as Array<{ source: string; count: number }>).forEach((r) => {
          bySource[r.source] = r.count;
        });
      } else {
        // Fallback: individual count queries per known source
        for (const src of ['edgar', 'federal_register', 'dapip', 'openalex', 'uspto', 'acnc']) {
          const { count } = await dbAny
            .from('public_records')
            .select('*', { count: 'exact', head: true })
            .eq('source', src);
          if (count && count > 0) bySource[src] = count;
        }
      }

      setStats({
        totalRecords: totalRecords ?? 0,
        anchoredRecords: anchoredRecords ?? 0,
        pendingRecords: pendingRecords ?? 0,
        embeddedRecords: embeddedRecords ?? 0,
        bySource,
        recentErrors: 0,
      });
    } catch {
      // Stats fetch failed — set empty state so UI doesn't hang on skeleton
      setStats({ totalRecords: 0, anchoredRecords: 0, pendingRecords: 0, embeddedRecords: 0, bySource: {}, recentErrors: 0 });
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isAdmin) {
      fetchStats();
      // Auto-refresh every 30 seconds
      const interval = setInterval(fetchStats, 30_000);
      return () => clearInterval(interval);
    } else {
      setLoading(false);
    }
  }, [isAdmin, fetchStats]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    fetchStats().finally(() => setRefreshing(false));
  }, [fetchStats]);

  const [triggerStatus, setTriggerStatus] = useState<Record<string, 'idle' | 'running' | 'done' | 'error'>>({});

  const triggerJob = useCallback(async (jobPath: string, _label: string) => {
    setTriggerStatus((prev) => ({ ...prev, [jobPath]: 'running' }));
    try {
      const response = await workerFetch(`/jobs/${jobPath}`, {
        method: 'POST',
      });
      if (response.ok) {
        setTriggerStatus((prev) => ({ ...prev, [jobPath]: 'done' }));
        // Refresh stats after a job completes — immediate, 3s, and 8s for DB propagation
        fetchStats();
        setTimeout(() => fetchStats(), 3000);
        setTimeout(() => {
          fetchStats();
          setTriggerStatus((prev) => ({ ...prev, [jobPath]: 'idle' }));
        }, 8000);
      } else {
        setTriggerStatus((prev) => ({ ...prev, [jobPath]: 'error' }));
        setTimeout(() => setTriggerStatus((prev) => ({ ...prev, [jobPath]: 'idle' })), 5000);
      }
    } catch {
      setTriggerStatus((prev) => ({ ...prev, [jobPath]: 'error' }));
      setTimeout(() => setTriggerStatus((prev) => ({ ...prev, [jobPath]: 'idle' })), 5000);
    }
  }, [fetchStats]);

  // ─── Records Browser State ────────────────────────
  const [records, setRecords] = useState<PublicRecord[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsTotal, setRecordsTotal] = useState(0);
  const [recordsPage, setRecordsPage] = useState(0);
  const [filters, setFilters] = useState<RecordFilters>({
    source: 'all',
    recordType: 'all',
    anchorStatus: 'all',
    search: '',
  });
  const [availableTypes, setAvailableTypes] = useState<string[]>([]);
  const [searchInput, setSearchInput] = useState('');
  const [selectedRecord, setSelectedRecord] = useState<PublicRecord | null>(null);
  const [anchorDetails, setAnchorDetails] = useState<AnchorDetails | null>(null);
  const [anchorLoading, setAnchorLoading] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const handleRecordClick = useCallback(async (record: PublicRecord) => {
    setSelectedRecord(record);
    setAnchorDetails(null);

    // Scroll the detail panel into view after render
    setTimeout(() => {
      document.getElementById('pipeline-record-detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);

    if (record.anchor_id) {
      setAnchorLoading(true);
      try {
        const { data } = await dbAny
          .from('anchors')
          .select('id, fingerprint, status, chain_tx_id, chain_block_height, chain_timestamp, public_id, credential_type, created_at')
          .eq('id', record.anchor_id)
          .single();
        if (data) setAnchorDetails(data as AnchorDetails);
      } catch {
        // Anchor fetch failed
      } finally {
        setAnchorLoading(false);
      }
    }
  }, [dbAny]);

  const handleCopy = useCallback((text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  }, []);

  // Fetch distinct record_types for filter dropdown
  useEffect(() => {
    if (!isAdmin) return;
    (async () => {
      const { data } = await dbAny
        .from('public_records')
        .select('record_type')
        .limit(1000);
      if (data) {
        const types = [...new Set((data as Array<{ record_type: string }>).map((r) => r.record_type))].sort();
        setAvailableTypes(types);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const fetchRecords = useCallback(async (page: number, currentFilters: RecordFilters) => {
    setRecordsLoading(true);
    try {
      let query = dbAny
        .from('public_records')
        .select('*', { count: 'exact' });

      if (currentFilters.source !== 'all') {
        query = query.eq('source', currentFilters.source);
      }
      if (currentFilters.recordType !== 'all') {
        query = query.eq('record_type', currentFilters.recordType);
      }
      if (currentFilters.anchorStatus === 'anchored') {
        query = query.not('anchor_id', 'is', null);
      } else if (currentFilters.anchorStatus === 'unanchored') {
        query = query.is('anchor_id', null);
      }
      if (currentFilters.search.trim()) {
        query = query.or(`title.ilike.%${currentFilters.search.trim()}%,source_id.ilike.%${currentFilters.search.trim()}%`);
      }

      const { data, count } = await query
        .order('created_at', { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

      setRecords((data ?? []) as PublicRecord[]);
      setRecordsTotal(count ?? 0);
    } catch {
      // Records fetch failed silently
    } finally {
      setRecordsLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch records when filters or page change
  useEffect(() => {
    if (isAdmin) {
      fetchRecords(recordsPage, filters);
    }
  }, [isAdmin, recordsPage, filters, fetchRecords]);

  const handleFilterChange = (key: keyof RecordFilters, value: string) => {
    setRecordsPage(0);
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const handleSearchSubmit = () => {
    setRecordsPage(0);
    setFilters((prev) => ({ ...prev, search: searchInput }));
  };

  const totalPages = Math.ceil(recordsTotal / PAGE_SIZE);

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
      case 'openalex': return <GraduationCap className="h-4 w-4" />;
      case 'dapip': return <Building2 className="h-4 w-4" />;
      case 'acnc': return <Heart className="h-4 w-4" />;
      default: return <Database className="h-4 w-4" />;
    }
  };

  const sourceLabel = (source: string) => {
    switch (source) {
      case 'edgar': return PIPELINE_LABELS.SOURCE_EDGAR;
      case 'uspto': return PIPELINE_LABELS.SOURCE_USPTO;
      case 'federal_register': return PIPELINE_LABELS.SOURCE_FEDERAL_REGISTER;
      case 'openalex': return 'OpenAlex Academic';
      case 'dapip': return 'DAPIP Education';
      case 'acnc': return 'ACNC Charities';
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
                    <div
                      key={source}
                      className="flex items-center justify-between py-2 border-b border-border/50 last:border-0 cursor-pointer hover:bg-[#00d4ff]/5 rounded px-2 -mx-2 transition-colors"
                      onClick={() => {
                        handleFilterChange('source', source);
                        document.getElementById('pipeline-records-browser')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }}
                    >
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

        {/* Pipeline Controls */}
        <Card className="border-[#00d4ff]/10 bg-transparent">
          <CardHeader>
            <CardTitle className="text-base">Pipeline Controls</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {([
                { path: 'fetch-edgar', label: 'Run EDGAR Fetch', icon: <FileText className="h-4 w-4" /> },
                { path: 'fetch-uspto', label: 'Run USPTO Fetch', icon: <Scale className="h-4 w-4" /> },
                { path: 'fetch-federal-register', label: 'Run Fed Register Fetch', icon: <BookOpen className="h-4 w-4" /> },
                { path: 'fetch-openalex', label: 'Run OpenAlex Fetch', icon: <GraduationCap className="h-4 w-4" /> },
                { path: 'fetch-dapip', label: 'Run DAPIP Fetch', icon: <Building2 className="h-4 w-4" /> },
                { path: 'fetch-acnc', label: 'Run ACNC Fetch', icon: <Heart className="h-4 w-4" /> },
                { path: 'embed-public-records', label: 'Run Embedder', icon: <Cpu className="h-4 w-4" /> },
                { path: 'anchor-public-records', label: 'Run Anchoring', icon: <Shield className="h-4 w-4" /> },
                { path: 'batch-anchors', label: 'Run Batch Anchoring', icon: <Layers className="h-4 w-4" /> },
              ] as const).map(({ path, label, icon }) => {
                const status = triggerStatus[path] ?? 'idle';
                return (
                  <Button
                    key={path}
                    variant="outline"
                    size="sm"
                    className="justify-start border-[#00d4ff]/20 hover:bg-[#00d4ff]/5"
                    disabled={status === 'running'}
                    onClick={() => triggerJob(path, label)}
                  >
                    {status === 'running' ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <span className="mr-2">{icon}</span>
                    )}
                    {label}
                    {status === 'done' && <Badge variant="secondary" className="ml-auto text-emerald-400">Done</Badge>}
                    {status === 'error' && <Badge variant="destructive" className="ml-auto">Error</Badge>}
                  </Button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Jobs run on the worker. Requires CRON_SECRET.
            </p>
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

        {/* Records Browser */}
        <Card id="pipeline-records-browser" className="border-[#00d4ff]/10 bg-transparent">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">{PIPELINE_LABELS.RECORDS_BROWSER_TITLE}</CardTitle>
                <p className="text-xs text-muted-foreground mt-1">
                  {PIPELINE_LABELS.RECORDS_BROWSER_DESCRIPTION}
                </p>
              </div>
              <span className="text-xs text-muted-foreground font-mono">
                {recordsTotal.toLocaleString()} records
              </span>
            </div>
          </CardHeader>
          <CardContent>
            {/* Filters Row */}
            <div className="flex flex-col sm:flex-row gap-3 mb-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder={PIPELINE_LABELS.FILTER_SEARCH_PLACEHOLDER}
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSearchSubmit(); }}
                  className="pl-9 bg-transparent border-[#00d4ff]/20"
                />
              </div>
              <Select value={filters.source} onValueChange={(v) => handleFilterChange('source', v)}>
                <SelectTrigger className="w-full sm:w-[160px] bg-transparent border-[#00d4ff]/20">
                  <SelectValue placeholder={PIPELINE_LABELS.FILTER_ALL_SOURCES} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{PIPELINE_LABELS.FILTER_ALL_SOURCES}</SelectItem>
                  <SelectItem value="edgar">{PIPELINE_LABELS.SOURCE_EDGAR}</SelectItem>
                  <SelectItem value="uspto">{PIPELINE_LABELS.SOURCE_USPTO}</SelectItem>
                  <SelectItem value="federal_register">{PIPELINE_LABELS.SOURCE_FEDERAL_REGISTER}</SelectItem>
                  <SelectItem value="openalex">{PIPELINE_LABELS.SOURCE_OPENALEX}</SelectItem>
                  <SelectItem value="dapip">DAPIP Education</SelectItem>
                  <SelectItem value="acnc">ACNC Charities</SelectItem>
                </SelectContent>
              </Select>
              <Select value={filters.recordType} onValueChange={(v) => handleFilterChange('recordType', v)}>
                <SelectTrigger className="w-full sm:w-[160px] bg-transparent border-[#00d4ff]/20">
                  <SelectValue placeholder={PIPELINE_LABELS.FILTER_ALL_TYPES} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{PIPELINE_LABELS.FILTER_ALL_TYPES}</SelectItem>
                  {availableTypes.map((t) => (
                    <SelectItem key={t} value={t}>{t.replace(/_/g, ' ')}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filters.anchorStatus} onValueChange={(v) => handleFilterChange('anchorStatus', v)}>
                <SelectTrigger className="w-full sm:w-[160px] bg-transparent border-[#00d4ff]/20">
                  <SelectValue placeholder={PIPELINE_LABELS.FILTER_ALL_STATUSES} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{PIPELINE_LABELS.FILTER_ALL_STATUSES}</SelectItem>
                  <SelectItem value="anchored">{PIPELINE_LABELS.FILTER_ANCHORED}</SelectItem>
                  <SelectItem value="unanchored">{PIPELINE_LABELS.FILTER_UNANCHORED}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Records Table */}
            {recordsLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : records.length === 0 ? (
              <div className="text-center py-12">
                <Database className="mx-auto h-10 w-10 text-muted-foreground mb-3" />
                <p className="text-sm text-muted-foreground">{PIPELINE_LABELS.RECORDS_NO_RESULTS}</p>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto rounded-md border border-border/50">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border/50 hover:bg-transparent">
                        <TableHead className="text-xs font-semibold">Source</TableHead>
                        <TableHead className="text-xs font-semibold">Title</TableHead>
                        <TableHead className="text-xs font-semibold hidden md:table-cell">Type</TableHead>
                        <TableHead className="text-xs font-semibold hidden lg:table-cell">Source ID</TableHead>
                        <TableHead className="text-xs font-semibold hidden lg:table-cell">Fingerprint</TableHead>
                        <TableHead className="text-xs font-semibold">Status</TableHead>
                        <TableHead className="text-xs font-semibold hidden md:table-cell">Ingested</TableHead>
                        <TableHead className="text-xs font-semibold w-10" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {records.map((record) => (
                        <TableRow
                          key={record.id}
                          className={`border-border/50 cursor-pointer transition-colors ${selectedRecord?.id === record.id ? 'bg-[#00d4ff]/5' : 'hover:bg-[#00d4ff]/5'}`}
                          onClick={() => handleRecordClick(record)}
                        >
                          <TableCell className="py-2">
                            <div className="flex items-center gap-2">
                              {sourceIcon(record.source)}
                              <span className="text-xs font-medium">{sourceLabel(record.source)}</span>
                            </div>
                          </TableCell>
                          <TableCell className="py-2 max-w-[280px]">
                            <span className="text-sm truncate block" title={record.title ?? ''}>
                              {record.title || '(untitled)'}
                            </span>
                          </TableCell>
                          <TableCell className="py-2 hidden md:table-cell">
                            <Badge variant="secondary" className="text-[10px] font-mono">
                              {record.record_type.replace(/_/g, ' ')}
                            </Badge>
                          </TableCell>
                          <TableCell className="py-2 hidden lg:table-cell">
                            <span className="text-xs font-mono text-muted-foreground truncate block max-w-[140px]" title={record.source_id}>
                              {record.source_id}
                            </span>
                          </TableCell>
                          <TableCell className="py-2 hidden lg:table-cell">
                            <span className="text-xs font-mono text-muted-foreground" title={record.content_hash}>
                              {record.content_hash.slice(0, 12)}…
                            </span>
                          </TableCell>
                          <TableCell className="py-2">
                            {record.anchor_id ? (
                              <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-[10px]">
                                <Shield className="h-3 w-3 mr-1" />
                                Anchored
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-muted-foreground border-border/50 text-[10px]">
                                Pending
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="py-2 hidden md:table-cell">
                            <span className="text-xs text-muted-foreground">
                              {new Date(record.created_at).toLocaleDateString('en-US', {
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                              })}
                            </span>
                          </TableCell>
                          <TableCell className="py-2">
                            {record.source_url && (
                              <a
                                href={record.source_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[#00d4ff] hover:text-[#00d4ff]/80 transition-colors"
                                title="View original"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                {/* Record Detail Panel */}
                {selectedRecord && (
                  <div id="pipeline-record-detail" className="mt-4 rounded-lg border border-[#00d4ff]/20 bg-[#0d141b]/80 p-4 space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-semibold truncate pr-4">
                          {selectedRecord.title || '(untitled)'}
                        </h3>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant="secondary" className="text-[10px] font-mono">
                            {selectedRecord.record_type.replace(/_/g, ' ')}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {sourceLabel(selectedRecord.source)}
                          </span>
                          {selectedRecord.source_url && (
                            <a
                              href={selectedRecord.source_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[#00d4ff] hover:text-[#00d4ff]/80 text-xs flex items-center gap-1"
                            >
                              <ExternalLink className="h-3 w-3" />
                              Source
                            </a>
                          )}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                        onClick={(e) => { e.stopPropagation(); setSelectedRecord(null); }}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>

                    {/* Description / Abstract from metadata */}
                    {(() => {
                      const desc = selectedRecord.metadata?.abstract ?? selectedRecord.metadata?.description ?? selectedRecord.metadata?.summary;
                      return desc ? (
                        <div>
                          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Description</span>
                          <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                            {String(desc)}
                          </p>
                        </div>
                      ) : null;
                    })()}

                    <div className="grid gap-3 sm:grid-cols-2">
                      {/* Fingerprint */}
                      <div>
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Unique Fingerprint</span>
                        <div className="flex items-center gap-2 mt-1">
                          <code className="text-xs font-mono text-[#00d4ff] break-all">{selectedRecord.content_hash}</code>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleCopy(selectedRecord.content_hash, 'fingerprint'); }}
                            className="text-muted-foreground hover:text-foreground shrink-0"
                          >
                            {copiedField === 'fingerprint' ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                      </div>

                      {/* Source ID */}
                      <div>
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Source ID</span>
                        <div className="flex items-center gap-2 mt-1">
                          <code className="text-xs font-mono text-muted-foreground break-all">{selectedRecord.source_id}</code>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleCopy(selectedRecord.source_id, 'sourceId'); }}
                            className="text-muted-foreground hover:text-foreground shrink-0"
                          >
                            {copiedField === 'sourceId' ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Anchor Details */}
                    {selectedRecord.anchor_id && (
                      <div className="border-t border-border/50 pt-3">
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Anchor Record</span>
                        {anchorLoading ? (
                          <div className="flex items-center gap-2 mt-2">
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                            <span className="text-xs text-muted-foreground">Loading anchor details…</span>
                          </div>
                        ) : anchorDetails ? (
                          <div className="grid gap-3 sm:grid-cols-2 mt-2">
                            <div>
                              <span className="text-[10px] text-muted-foreground">Status</span>
                              <div className="mt-0.5">
                                <Badge className={
                                  anchorDetails.status === 'SECURED'
                                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                    : anchorDetails.status === 'SUBMITTED'
                                    ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                                    : 'bg-muted text-muted-foreground'
                                }>
                                  {anchorDetails.status}
                                </Badge>
                              </div>
                            </div>

                            <div>
                              <span className="text-[10px] text-muted-foreground">
                                {anchorDetails.chain_tx_id ? 'Network Receipt (Mempool)' : 'Mempool'}
                              </span>
                              <div className="flex items-center gap-2 mt-0.5">
                                {anchorDetails.chain_tx_id ? (
                                  <>
                                    <a
                                      href={mempoolTxUrl(anchorDetails.chain_tx_id)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-xs font-mono text-[#00d4ff] hover:text-[#00d4ff]/80 truncate max-w-[200px] flex items-center gap-1"
                                    >
                                      <Link2 className="h-3 w-3 shrink-0" />
                                      {anchorDetails.chain_tx_id.slice(0, 16)}…
                                    </a>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); handleCopy(anchorDetails.chain_tx_id!, 'txId'); }}
                                      className="text-muted-foreground hover:text-foreground shrink-0"
                                    >
                                      {copiedField === 'txId' ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                                    </button>
                                  </>
                                ) : (
                                  <a
                                    href={mempoolAddressUrl()}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1"
                                  >
                                    <Link2 className="h-3 w-3 shrink-0" />
                                    Awaiting anchor — view on network
                                  </a>
                                )}
                              </div>
                            </div>

                            {anchorDetails.chain_block_height && (
                              <div>
                                <span className="text-[10px] text-muted-foreground">Block Height</span>
                                <p className="text-xs font-mono mt-0.5">{anchorDetails.chain_block_height.toLocaleString()}</p>
                              </div>
                            )}

                            {anchorDetails.chain_timestamp && (
                              <div>
                                <span className="text-[10px] text-muted-foreground">Network Observed Time</span>
                                <p className="text-xs font-mono mt-0.5">
                                  {new Date(anchorDetails.chain_timestamp).toLocaleString('en-US', {
                                    dateStyle: 'medium',
                                    timeStyle: 'short',
                                  })}
                                </p>
                              </div>
                            )}

                            <div>
                              <span className="text-[10px] text-muted-foreground">Public ID</span>
                              <div className="flex items-center gap-2 mt-0.5">
                                <code className="text-xs font-mono text-muted-foreground">{anchorDetails.public_id}</code>
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleCopy(anchorDetails.public_id, 'publicId'); }}
                                  className="text-muted-foreground hover:text-foreground shrink-0"
                                >
                                  {copiedField === 'publicId' ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground mt-1">Anchor record not found</p>
                        )}
                      </div>
                    )}

                    {/* Metadata (additional fields) */}
                    {selectedRecord.metadata && Object.keys(selectedRecord.metadata).length > 0 && (
                      <div className="border-t border-border/50 pt-3">
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Metadata</span>
                        <div className="grid gap-1.5 mt-2">
                          {Object.entries(selectedRecord.metadata)
                            .filter(([key]) => !['abstract', 'description', 'summary', 'merkle_proof', 'merkle_root', 'chain_tx_id', 'batch_id', 'pipeline_source'].includes(key))
                            .filter(([, value]) => value !== null && value !== undefined && value !== '')
                            .slice(0, 12)
                            .map(([key, value]) => {
                              let display: string;
                              if (Array.isArray(value)) {
                                if (value.length === 0) {
                                  display = '—';
                                } else if (typeof value[0] === 'object') {
                                  display = `${value.length} items`;
                                } else {
                                  display = value.join(', ');
                                }
                              } else if (typeof value === 'object' && value !== null) {
                                display = JSON.stringify(value).length > 200 ? `{...}` : JSON.stringify(value);
                              } else {
                                display = String(value);
                              }
                              return (
                                <div key={key} className="flex gap-2 text-xs">
                                  <span className="text-muted-foreground shrink-0 min-w-[100px]">{key.replace(/_/g, ' ')}:</span>
                                  <span className="font-mono text-muted-foreground break-words whitespace-normal">{display}</span>
                                </div>
                              );
                            })}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Pagination */}
                <div className="flex items-center justify-between mt-4">
                  <p className="text-xs text-muted-foreground">
                    {PIPELINE_LABELS.RECORDS_SHOWING}{' '}
                    <span className="font-mono">{recordsPage * PAGE_SIZE + 1}–{Math.min((recordsPage + 1) * PAGE_SIZE, recordsTotal)}</span>
                    {' '}{PIPELINE_LABELS.RECORDS_OF}{' '}
                    <span className="font-mono">{recordsTotal.toLocaleString()}</span>
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={recordsPage === 0}
                      onClick={() => setRecordsPage((p) => p - 1)}
                      className="h-8 w-8 p-0 border-[#00d4ff]/20"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="text-xs font-mono text-muted-foreground">
                      {recordsPage + 1} / {totalPages || 1}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={recordsPage >= totalPages - 1}
                      onClick={() => setRecordsPage((p) => p + 1)}
                      className="h-8 w-8 p-0 border-[#00d4ff]/20"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </>
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
