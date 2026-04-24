/**
 * Pipeline Monitoring Dashboard (PH1-DATA-05)
 *
 * Admin-only page showing data ingestion, anchoring, and embedding pipeline status.
 * Queries public_records and public_record_embeddings tables for real-time metrics.
 *
 * Platform admin only (carson@arkova.ai, sarah@arkova.ai).
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Database, Cpu, AlertCircle, FileText, Scale, BookOpen, GraduationCap, Loader2, Search, ExternalLink, ChevronLeft, ChevronRight, ChevronDown, X, Copy, Check, Link2, Layers, Building2, Heart, Landmark, Stethoscope, TrendingUp, Radio, ShieldCheck, AlertTriangle, BarChart3, Globe, MapPin, Gavel, Award, Briefcase, ScrollText, Shield } from 'lucide-react';
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
import { PIPELINE_LABELS, formatCredentialType } from '@/lib/copy';
import { supabase } from '@/lib/supabase';

import { isPlatformAdmin, mempoolTxUrl, mempoolAddressUrl } from '@/lib/platform';

interface PipelineStats {
  totalRecords: number;
  anchoredRecords: number;
  pendingRecords: number;
  embeddedRecords: number;
  anchorLinkedRecords: number;
  pendingRecordLinks: number;
  pendingAnchorRecords: number;
  broadcastingRecords: number;
  submittedRecords: number;
  securedRecords: number;
  cacheUpdatedAt: string | null;
  bySource: Record<string, number>;
  byCredentialType: Record<string, { total: number; secured: number; submitted: number; pending: number; broadcasting: number }>;
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
  anchor_status?: string | null;
  chain_tx_id?: string | null;
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

// SCRUM-1124: Pipeline jobs regularly exceed the 60s workerFetch default
// after PR #488 raised batchAnchorMaxSize to 10k — a full batch run (embed +
// Merkle + chain submit) takes 2–4 minutes. The 5-minute window lets the
// worker finish before AbortError flips the button to red. The worker has no
// request-level timeout; this only controls how long the browser waits.
const PIPELINE_JOB_TIMEOUT_MS = 5 * 60_000;

// ─── Pipeline Region + Source Config (module-scope to avoid re-allocation per render) ───

type PipelineRegion = 'us' | 'au' | 'ke' | 'eu' | 'uk' | 'latam' | 'sea' | 'intl' | 'global';

const REGION_LABELS: Record<PipelineRegion, string> = {
  us: '🇺🇸 United States',
  au: '🇦🇺 Australia',
  ke: '🇰🇪 Kenya',
  eu: '🇪🇺 European Union',
  uk: '🇬🇧 United Kingdom',
  latam: '🇧🇷 Latin America',
  sea: '🇸🇬 Southeast Asia',
  global: '🌐 Global',
  intl: '🌍 International',
};

const REGION_ORDER: PipelineRegion[] = ['us', 'au', 'ke', 'eu', 'uk', 'latam', 'sea', 'global', 'intl'];

const ICON_4 = 'h-4 w-4';
const INTERNATIONAL_JOB_GROUPS: Array<{ heading: string; jobs: Array<{ path: string; label: string; icon: React.ReactNode }> }> = [
  { heading: '🇦🇺 Australia', jobs: [
    { path: 'fetch-australia', label: 'AU Compliance (AHPRA/TEQSA/ASIC)', icon: <Globe className={ICON_4} /> },
    { path: 'fetch-acnc', label: 'ACNC Charities', icon: <Heart className={ICON_4} /> },
  ]},
  { heading: '🇰🇪 Kenya', jobs: [
    { path: 'fetch-kenya', label: 'KE Compliance (KNEC/LSK/ODPC)', icon: <Globe className={ICON_4} /> },
  ]},
  { heading: '🇪🇺 European Union', jobs: [
    { path: 'fetch-eurlex', label: 'EUR-Lex Legislation (needs key)', icon: <ScrollText className={ICON_4} /> },
  ]},
  { heading: '🇬🇧 United Kingdom', jobs: [
    { path: 'fetch-fca-uk', label: 'FCA Register (needs key)', icon: <TrendingUp className={ICON_4} /> },
    { path: 'fetch-companies-house', label: 'Companies House (needs key)', icon: <Building2 className={ICON_4} /> },
  ]},
  { heading: '🇸🇬 Southeast Asia', jobs: [
    { path: 'fetch-acra-sg', label: 'ACRA Singapore Companies', icon: <Building2 className={ICON_4} /> },
    { path: 'fetch-moh-sg', label: 'MOH Singapore Healthcare', icon: <Stethoscope className={ICON_4} /> },
  ]},
  { heading: '🇧🇷 Latin America', jobs: [
    { path: 'fetch-cnpj-br', label: 'CNPJ Brazil Companies', icon: <Building2 className={ICON_4} /> },
  ]},
];

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
      // Use worker endpoint (service_role, bypasses RLS) as primary source
      let totalRecords = 0;
      let anchoredRecords = 0;
      let pendingRecords = 0;
      let embeddedRecords = 0;
      let anchorLinkedRecords = 0;
      let pendingRecordLinks = 0;
      let pendingAnchorRecords = 0;
      let broadcastingRecords = 0;
      let submittedRecords = 0;
      let securedRecords = 0;
      let cacheUpdatedAt: string | null = null;
      const bySource: Record<string, number> = {};

      try {
        const response = await workerFetch('/api/admin/pipeline-stats', { method: 'GET' });
        if (response.ok) {
          const data = await response.json() as {
            totalRecords: number; anchoredRecords: number;
            pendingRecords: number; embeddedRecords: number;
            anchorLinkedRecords?: number; pendingRecordLinks?: number;
            pendingAnchorRecords?: number; broadcastingRecords?: number;
            submittedRecords?: number; securedRecords?: number;
            cacheUpdatedAt?: string | null;
            bySource: Record<string, number>;
          };
          totalRecords = data.totalRecords;
          anchoredRecords = data.anchoredRecords;
          pendingRecords = data.pendingRecords;
          embeddedRecords = data.embeddedRecords;
          anchorLinkedRecords = data.anchorLinkedRecords ?? data.anchoredRecords;
          pendingRecordLinks = data.pendingRecordLinks ?? 0;
          pendingAnchorRecords = data.pendingAnchorRecords ?? 0;
          broadcastingRecords = data.broadcastingRecords ?? 0;
          submittedRecords = data.submittedRecords ?? 0;
          securedRecords = data.securedRecords ?? 0;
          cacheUpdatedAt = data.cacheUpdatedAt ?? null;
          Object.assign(bySource, data.bySource);
        } else {
          throw new Error(`Worker returned ${response.status}`);
        }
      } catch {
        // Fallback: direct Supabase RPC (may fail due to RLS)
        const { data: pipelineStats, error: rpcError } = await dbAny.rpc('get_pipeline_stats');
        if (!rpcError && pipelineStats) {
          totalRecords = pipelineStats.total_records ?? 0;
          anchorLinkedRecords = pipelineStats.anchor_linked_records ?? pipelineStats.anchored_records ?? 0;
          pendingRecordLinks = pipelineStats.pending_record_links ?? 0;
          pendingAnchorRecords = pipelineStats.pending_anchor_records ?? 0;
          broadcastingRecords = pipelineStats.broadcasting_records ?? 0;
          submittedRecords = pipelineStats.submitted_records ?? 0;
          securedRecords = pipelineStats.secured_records ?? 0;
          anchoredRecords = pipelineStats.bitcoin_anchored_records ?? pipelineStats.anchored_records ?? 0;
          pendingRecords = pipelineStats.pending_bitcoin_records ?? pipelineStats.pending_records ?? 0;
          embeddedRecords = pipelineStats.embedded_records ?? 0;
          cacheUpdatedAt = typeof pipelineStats.cache_updated_at === 'string' ? pipelineStats.cache_updated_at : null;
        }

        const { data: sourceCounts } = await dbAny.rpc('count_public_records_by_source');
        if (sourceCounts && Array.isArray(sourceCounts)) {
          (sourceCounts as Array<{ source: string; count: number }>).forEach((r: { source: string; count: number }) => {
            bySource[r.source] = r.count;
          });
        }
      }

      // Anchor counts by credential_type and status (isolated — failure here won't kill the page)
      const byCredentialType: Record<string, { total: number; secured: number; submitted: number; pending: number; broadcasting: number }> = {};
      try {
        const { data: ctRows } = await dbAny.rpc('get_anchor_type_counts');
        if (ctRows && Array.isArray(ctRows)) {
          for (const row of ctRows as Array<{ credential_type: string | null; status: string; count: number }>) {
            const ct = row.credential_type ?? 'UNKNOWN';
            if (!byCredentialType[ct]) byCredentialType[ct] = { total: 0, secured: 0, submitted: 0, pending: 0, broadcasting: 0 };
            byCredentialType[ct].total += Number(row.count);
            const s = row.status?.toLowerCase() as 'secured' | 'submitted' | 'pending' | 'broadcasting';
            if (s in byCredentialType[ct]) byCredentialType[ct][s] += Number(row.count);
          }
        }
      } catch {
        // Type counts are non-critical — don't let this fail the whole page
      }

      setStats({
        totalRecords: totalRecords ?? 0,
        anchoredRecords: anchoredRecords ?? 0,
        pendingRecords: pendingRecords ?? 0,
        embeddedRecords: embeddedRecords ?? 0,
        anchorLinkedRecords: anchorLinkedRecords ?? anchoredRecords ?? 0,
        pendingRecordLinks: pendingRecordLinks ?? 0,
        pendingAnchorRecords: pendingAnchorRecords ?? 0,
        broadcastingRecords: broadcastingRecords ?? 0,
        submittedRecords: submittedRecords ?? 0,
        securedRecords: securedRecords ?? 0,
        cacheUpdatedAt,
        bySource,
        byCredentialType,
        recentErrors: 0,
      });
    } catch (err) {
      console.error('PipelineAdminPage: failed to fetch stats', err);
      // Stats fetch failed — set empty state so UI doesn't hang on skeleton
      setStats({
        totalRecords: 0,
        anchoredRecords: 0,
        pendingRecords: 0,
        embeddedRecords: 0,
        anchorLinkedRecords: 0,
        pendingRecordLinks: 0,
        pendingAnchorRecords: 0,
        broadcastingRecords: 0,
        submittedRecords: 0,
        securedRecords: 0,
        cacheUpdatedAt: null,
        bySource: {},
        byCredentialType: {},
        recentErrors: 0,
      });
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isAdmin) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- async data fetch; setState is post-await
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

  const triggerJob = useCallback(async (jobPath: string) => {
    setTriggerStatus((prev) => ({ ...prev, [jobPath]: 'running' }));
    try {
      const response = await workerFetch(
        `/jobs/${jobPath}`,
        { method: 'POST' },
        PIPELINE_JOB_TIMEOUT_MS,
      );
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
      // Use RPC or distinct query to get record types without fetching 1000 rows
      const { data } = await dbAny.rpc('get_distinct_record_types').catch(() => ({ data: null }));
      if (data && Array.isArray(data)) {
        const types = (data as Array<{ record_type: string }>).map((r) => r.record_type).sort();
        setAvailableTypes(types);
      } else {
        // Fallback removed — direct public_records query times out on 1.4M rows.
        // get_distinct_record_types RPC is the only path (migration 0175).
        setAvailableTypes([]);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const fetchRecords = useCallback(async (page: number, currentFilters: RecordFilters) => {
    setRecordsLoading(true);
    try {
      // Use server-side paginated RPC to avoid RLS timeout on 1.4M row table (migration 0175)
      const { data: rpcResult, error: rpcError } = await dbAny.rpc('get_public_records_page', {
        p_page: page + 1, // RPC uses 1-based pages
        p_page_size: PAGE_SIZE,
        p_source: currentFilters.source !== 'all' ? currentFilters.source : null,
        p_record_type: currentFilters.recordType !== 'all' ? currentFilters.recordType : null,
        p_anchor_status: currentFilters.anchorStatus !== 'all' ? currentFilters.anchorStatus : null,
        p_search: currentFilters.search.trim() || null,
      });

      if (rpcError) throw rpcError;

      const result = rpcResult as { data: PublicRecord[]; total: number };
      setRecords(result.data ?? []);
      setRecordsTotal(result.total ?? 0);
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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- async data fetch; setState is post-await
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

  const SOURCE_CONFIG: Record<string, { icon: React.ReactNode; label: string; category: 'compliance' | 'academic' | 'medical' | 'financial' | 'government' | 'international' | 'other'; region: PipelineRegion }> = {
    // ─── US Federal ───
    edgar: { icon: <FileText className="h-4 w-4" />, label: PIPELINE_LABELS.SOURCE_EDGAR, category: 'financial', region: 'us' },
    uspto: { icon: <Scale className="h-4 w-4" />, label: PIPELINE_LABELS.SOURCE_USPTO, category: 'academic', region: 'us' },
    federal_register: { icon: <BookOpen className="h-4 w-4" />, label: PIPELINE_LABELS.SOURCE_FEDERAL_REGISTER, category: 'government', region: 'us' },
    courtlistener: { icon: <Gavel className="h-4 w-4" />, label: 'CourtListener Legal', category: 'compliance', region: 'us' },
    openstates: { icon: <Landmark className="h-4 w-4" />, label: 'Open States Legislation', category: 'government', region: 'us' },
    npi: { icon: <Stethoscope className="h-4 w-4" />, label: 'NPI Medical Registry', category: 'medical', region: 'us' },
    finra: { icon: <TrendingUp className="h-4 w-4" />, label: 'FINRA BrokerCheck', category: 'financial', region: 'us' },
    sec_iapd: { icon: <TrendingUp className="h-4 w-4" />, label: 'SEC IAPD Advisors', category: 'financial', region: 'us' },
    fcc: { icon: <Radio className="h-4 w-4" />, label: 'FCC License Registry', category: 'government', region: 'us' },
    sam_gov: { icon: <ShieldCheck className="h-4 w-4" />, label: 'SAM.gov Contractors', category: 'government', region: 'us' },
    sam_gov_exclusions: { icon: <AlertTriangle className="h-4 w-4" />, label: 'SAM.gov Exclusions', category: 'government', region: 'us' },
    dapip: { icon: <Building2 className="h-4 w-4" />, label: 'DAPIP Accreditation', category: 'academic', region: 'us' },
    ipeds: { icon: <GraduationCap className="h-4 w-4" />, label: 'IPEDS Education', category: 'academic', region: 'us' },
    // ─── US State ───
    calbar: { icon: <Scale className="h-4 w-4" />, label: 'California State Bar', category: 'compliance', region: 'us' },
    sos_de: { icon: <Building2 className="h-4 w-4" />, label: 'Delaware SOS', category: 'compliance', region: 'us' },
    sos_ca: { icon: <Building2 className="h-4 w-4" />, label: 'California SOS', category: 'compliance', region: 'us' },
    license_ca_nursing: { icon: <Stethoscope className="h-4 w-4" />, label: 'CA Nursing Board', category: 'medical', region: 'us' },
    insurance_ca_cdi: { icon: <ShieldCheck className="h-4 w-4" />, label: 'CA Dept of Insurance', category: 'financial', region: 'us' },
    cle_ny: { icon: <Scale className="h-4 w-4" />, label: 'NY CLE Board', category: 'compliance', region: 'us' },
    cert_cfa: { icon: <TrendingUp className="h-4 w-4" />, label: 'CFA Institute', category: 'financial', region: 'us' },
    // ─── US Compliance Frameworks (NCX) ───
    ecfr: { icon: <ScrollText className="h-4 w-4" />, label: 'eCFR Regulations', category: 'compliance', region: 'us' },
    hhs_enforcement: { icon: <Shield className="h-4 w-4" />, label: 'HHS/HIPAA Enforcement', category: 'compliance', region: 'us' },
    nasba: { icon: <Award className="h-4 w-4" />, label: 'NASBA CPE Registry', category: 'compliance', region: 'us' },
    accme: { icon: <Stethoscope className="h-4 w-4" />, label: 'ACCME CME Providers', category: 'medical', region: 'us' },
    nces: { icon: <GraduationCap className="h-4 w-4" />, label: 'NCES Transcript Data', category: 'academic', region: 'us' },
    soc2: { icon: <ShieldCheck className="h-4 w-4" />, label: 'SOC 2 Controls', category: 'compliance', region: 'global' },
    iso27001: { icon: <Shield className="h-4 w-4" />, label: 'ISO 27001 Annex A', category: 'compliance', region: 'global' },
    nist800_53: { icon: <Shield className="h-4 w-4" />, label: 'NIST 800-53 Controls', category: 'compliance', region: 'us' },
    // ─── Australia ───
    acnc: { icon: <Heart className="h-4 w-4" />, label: 'ACNC Charities', category: 'compliance', region: 'au' },
    ahpra: { icon: <Stethoscope className="h-4 w-4" />, label: 'AHPRA Health Practitioners', category: 'medical', region: 'au' },
    teqsa: { icon: <GraduationCap className="h-4 w-4" />, label: 'TEQSA Higher Education', category: 'academic', region: 'au' },
    asic: { icon: <Briefcase className="h-4 w-4" />, label: 'ASIC Business Registry', category: 'financial', region: 'au' },
    // ─── Kenya ───
    knec: { icon: <GraduationCap className="h-4 w-4" />, label: 'KNEC Examinations', category: 'academic', region: 'ke' },
    lsk: { icon: <Scale className="h-4 w-4" />, label: 'Law Society of Kenya', category: 'compliance', region: 'ke' },
    odpc: { icon: <Shield className="h-4 w-4" />, label: 'ODPC Data Protection', category: 'compliance', region: 'ke' },
    // ─── International / Global ───
    openalex: { icon: <Globe className="h-4 w-4" />, label: 'OpenAlex Academic', category: 'academic', region: 'global' },
    mcp: { icon: <Database className="h-4 w-4" />, label: PIPELINE_LABELS.SOURCE_MCP, category: 'other', region: 'global' },
    // 🇪🇺 European Union
    eurlex: { icon: <ScrollText className="h-4 w-4" />, label: 'EUR-Lex Legislation (needs key)', category: 'compliance', region: 'eu' },
    // 🇬🇧 United Kingdom
    fca_uk: { icon: <TrendingUp className="h-4 w-4" />, label: 'FCA Register (needs key)', category: 'financial', region: 'uk' },
    companies_house: { icon: <Building2 className="h-4 w-4" />, label: 'Companies House (needs key)', category: 'compliance', region: 'uk' },
    // 🇧🇷 Latin America
    cnpj_br: { icon: <Building2 className="h-4 w-4" />, label: 'CNPJ Brazil Companies', category: 'compliance', region: 'latam' },
    // 🇸🇬 Southeast Asia
    acra_sg: { icon: <Building2 className="h-4 w-4" />, label: 'ACRA Singapore Companies', category: 'compliance', region: 'sea' },
    moh_sg: { icon: <Stethoscope className="h-4 w-4" />, label: 'MOH Singapore Healthcare', category: 'medical', region: 'sea' },
  };

  // REGION_LABELS and REGION_ORDER are at module scope

  const sourceIcon = (source: string) => SOURCE_CONFIG[source]?.icon ?? <Database className="h-4 w-4" />;
  const sourceLabel = (source: string) => SOURCE_CONFIG[source]?.label ?? source;
  const renderAnchorStatusBadge = (record: PublicRecord) => {
    if (record.chain_tx_id && (record.anchor_status === 'SUBMITTED' || record.anchor_status === 'SECURED')) {
      return (
        <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-[10px]">
          <ArkovaIcon className="h-3 w-3 mr-1" />
          Anchored
        </Badge>
      );
    }

    if (record.anchor_id) {
      return (
        <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/20 text-[10px]">
          {record.anchor_status ?? 'Queued'}
        </Badge>
      );
    }

    return (
      <Badge variant="outline" className="text-muted-foreground border-border/50 text-[10px]">
        Unlinked
      </Badge>
    );
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
            icon={<ArkovaIcon className="h-5 w-5 text-emerald-400" />}
            loading={loading}
            subtitle={`${(stats?.submittedRecords ?? 0).toLocaleString()} submitted / ${(stats?.securedRecords ?? 0).toLocaleString()} confirmed`}
          />
          <StatCard
            label={PIPELINE_LABELS.RECORDS_PENDING}
            value={stats?.pendingRecords}
            icon={<AlertCircle className="h-5 w-5 text-amber-400" />}
            loading={loading}
            subtitle={`${(stats?.pendingRecordLinks ?? 0).toLocaleString()} unlinked / ${(stats?.pendingAnchorRecords ?? 0).toLocaleString()} queued / ${(stats?.broadcastingRecords ?? 0).toLocaleString()} broadcasting`}
          />
          <StatCard
            label={PIPELINE_LABELS.RECORDS_EMBEDDED}
            value={stats?.embeddedRecords}
            icon={<Cpu className="h-5 w-5 text-purple-400" />}
            loading={loading}
            subtitle="Vector embeddings enable AI search and cross-reference matching across all pipeline records"
          />
        </div>

        {/* Data Quality Overview — NPH-04 */}
        {!loading && stats && <DataQualityCard stats={stats} sourceConfigCount={Object.keys(SOURCE_CONFIG).length} />}

        {/* Source Breakdown — grouped by region */}
        <CollapsibleSection title="Records by Source & Region" icon={<Globe className="h-4 w-4" />} defaultOpen={false} badge={Object.keys(stats?.bySource ?? {}).length + ' sources'}>
            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-full" />)}
              </div>
            ) : (() => {
              const bySourceEntries = Object.entries(stats?.bySource ?? {}).sort(([, a], [, b]) => b - a);
              // Group by region
              const regionGroups: Record<string, Array<[string, number]>> = {};
              for (const [source, count] of bySourceEntries) {
                const region = SOURCE_CONFIG[source]?.region ?? 'global';
                if (!regionGroups[region]) regionGroups[region] = [];
                regionGroups[region].push([source, count]);
              }
              const regionOrder = REGION_ORDER;

              return (
                <div className="space-y-4">
                  {regionOrder.filter(r => regionGroups[r]?.length).map(region => (
                    <div key={region}>
                      <div className="flex items-center gap-2 mb-2">
                        <MapPin className="h-3 w-3 text-muted-foreground" />
                        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          {REGION_LABELS[region] ?? region}
                        </span>
                        <Badge variant="outline" className="text-xs font-mono ml-auto">
                          {regionGroups[region].reduce((sum, [, c]) => sum + c, 0).toLocaleString()}
                        </Badge>
                      </div>
                      <div className="space-y-1 ml-5">
                        {regionGroups[region].map(([source, count]) => (
                          <div
                            key={source}
                            className="flex items-center justify-between py-1.5 border-b border-border/30 last:border-0 cursor-pointer hover:bg-[#00d4ff]/5 rounded px-2 -mx-2 transition-colors"
                            onClick={() => {
                              handleFilterChange('source', source);
                              document.getElementById('pipeline-records-browser')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                            }}
                          >
                            <div className="flex items-center gap-2">
                              {sourceIcon(source)}
                              <span className="text-sm">{sourceLabel(source)}</span>
                            </div>
                            <Badge variant="secondary" className="font-mono text-xs">
                              {count.toLocaleString()}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                  {bySourceEntries.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No records ingested yet. Run the data pipeline to start.
                    </p>
                  )}
                </div>
              );
            })()}
        </CollapsibleSection>

        {/* Anchors by Credential Type */}
        <CollapsibleSection title="Anchors by Credential Type" defaultOpen={false} badge={Object.keys(stats?.byCredentialType ?? {}).length + ' types'}>
            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-full" />)}
              </div>
            ) : (
              <div className="space-y-2">
                {Object.entries(stats?.byCredentialType ?? {})
                  .sort(([, a], [, b]) => b.total - a.total)
                  .map(([ct, counts]) => {
                    const label = PIPELINE_LABELS[`TYPE_${ct}` as keyof typeof PIPELINE_LABELS] ?? formatCredentialType(ct);
                    const securedPct = counts.total > 0 ? Math.round((counts.secured / counts.total) * 100) : 0;
                    return (
                      <div
                        key={ct}
                        className="flex items-center justify-between py-2 border-b border-border/50 last:border-0 cursor-pointer hover:bg-[#00d4ff]/5 rounded px-2 -mx-2 transition-colors"
                        onClick={() => {
                          handleFilterChange('recordType', ct.toLowerCase());
                          document.getElementById('pipeline-records-browser')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <ArkovaIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="text-sm font-medium">{label}</span>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <div className="flex items-center gap-1.5 text-xs">
                            <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-[10px] font-mono">
                              {counts.secured.toLocaleString()}
                            </Badge>
                            {counts.broadcasting > 0 && (
                              <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/20 text-[10px] font-mono" title="Broadcasting">
                                {counts.broadcasting.toLocaleString()}
                              </Badge>
                            )}
                            {counts.submitted > 0 && (
                              <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/20 text-[10px] font-mono" title="Submitted">
                                {counts.submitted.toLocaleString()}
                              </Badge>
                            )}
                            {counts.pending > 0 && (
                              <Badge variant="outline" className="text-muted-foreground border-border/50 text-[10px] font-mono">
                                {counts.pending.toLocaleString()}
                              </Badge>
                            )}
                          </div>
                          <div className="w-20 bg-muted rounded-full h-1.5 hidden sm:block">
                            <div
                              className="bg-emerald-400 h-1.5 rounded-full transition-all"
                              style={{ width: `${securedPct}%` }}
                            />
                          </div>
                          <Badge variant="secondary" className="font-mono text-[10px] w-16 justify-center">
                            {counts.total.toLocaleString()}
                          </Badge>
                        </div>
                      </div>
                    );
                  })}
                {Object.keys(stats?.byCredentialType ?? {}).length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No anchor data available.
                  </p>
                )}
              </div>
            )}
        </CollapsibleSection>

        {/* Pipeline Controls — grouped by category */}
        <CollapsibleSection title="Pipeline Controls" defaultOpen={false}>
          <div className="space-y-5">
            {/* Processing */}
            <div>
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Processing</h4>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <JobButton path="embed-public-records" label="Run Embedder" icon={<Cpu className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
                <JobButton path="anchor-public-records" label="Run Anchoring" icon={<ArkovaIcon className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
                <JobButton path="batch-anchors" label="Run Batch Anchoring" icon={<Layers className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
              </div>
            </div>

            {/* 🇺🇸 Federal / Compliance Sources */}
            <div>
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">🇺🇸 Federal &amp; Compliance</h4>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <JobButton path="fetch-edgar" label="SEC EDGAR" icon={<FileText className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
                <JobButton path="fetch-federal-register" label="Federal Register" icon={<BookOpen className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
                <JobButton path="fetch-courtlistener" label="CourtListener" icon={<Gavel className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
                <JobButton path="fetch-all-state-bills" label="State Bills (CA/NY/TX)" icon={<FileText className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
                <JobButton path="fetch-sam-entities" label="SAM.gov" icon={<ShieldCheck className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
                <JobButton path="fetch-ecfr" label="eCFR Regulations" icon={<ScrollText className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
                <JobButton path="fetch-enforcement" label="HHS Enforcement" icon={<Shield className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
                <JobButton path="fetch-ce" label="NASBA/ACCME CE" icon={<Award className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
              </div>
            </div>

            {/* Professional Licensing */}
            <div>
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Professional Licensing</h4>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <JobButton path="fetch-npi" label="NPI Medical" icon={<Stethoscope className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
                <JobButton path="fetch-finra" label="FINRA BrokerCheck" icon={<TrendingUp className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
                <JobButton path="fetch-calbar" label="CA State Bar" icon={<Scale className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
                <JobButton path="fetch-sec-iapd" label="SEC IAPD" icon={<TrendingUp className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
                <JobButton path="fetch-fcc" label="FCC Licenses" icon={<Radio className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
                <JobButton path="fetch-licensing-board" label="Licensing Boards" icon={<Stethoscope className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
                <JobButton path="fetch-insurance-licenses" label="Insurance (CDI)" icon={<ShieldCheck className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
                <JobButton path="fetch-cle" label="CLE Credits" icon={<Scale className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
                <JobButton path="fetch-certifications" label="Certifications" icon={<TrendingUp className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
              </div>
            </div>

            {/* Academic & Education */}
            <div>
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Academic &amp; Education</h4>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <JobButton path="fetch-openalex" label="OpenAlex" icon={<GraduationCap className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
                <JobButton path="fetch-uspto" label="USPTO Patents" icon={<Scale className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
                <JobButton path="fetch-dapip" label="DAPIP Accreditation" icon={<Building2 className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
                <JobButton path="fetch-ipeds" label="IPEDS Education" icon={<GraduationCap className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
              </div>
            </div>

            {/* Business Entities */}
            <div>
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">🏢 Business Entities</h4>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <JobButton path="fetch-sos" label="State SOS Entities" icon={<Building2 className="h-4 w-4" />} status={triggerStatus} onTrigger={triggerJob} />
              </div>
            </div>

            {/* International region groups — data-driven */}
            {INTERNATIONAL_JOB_GROUPS.map(({ heading, jobs }) => (
              <div key={heading}>
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">{heading}</h4>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {jobs.map(j => (
                    <JobButton key={j.path} path={j.path} label={j.label} icon={j.icon} status={triggerStatus} onTrigger={triggerJob} />
                  ))}
                </div>
              </div>
            ))}

            <p className="text-xs text-muted-foreground">
              Jobs run on the worker service. Authenticated via platform admin JWT.
            </p>
          </div>
        </CollapsibleSection>

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
                  <SelectItem value="courtlistener">CourtListener Legal</SelectItem>
                  <SelectItem value="openstates">Open States Legislation</SelectItem>
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
                            {renderAnchorStatusBadge(record)}
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

function CollapsibleSection({ title, icon, defaultOpen = false, badge, children }: {
  title: string;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  badge?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card className="border-[#00d4ff]/10 bg-transparent">
      <CardHeader
        className="cursor-pointer select-none hover:bg-[#00d4ff]/5 transition-colors"
        onClick={() => setOpen(!open)}
      >
        <CardTitle className="text-base flex items-center gap-2">
          {icon}
          <span className="flex-1">{title}</span>
          {badge && <Badge variant="outline" className="text-xs font-mono">{badge}</Badge>}
          <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </CardTitle>
      </CardHeader>
      {open && <CardContent>{children}</CardContent>}
    </Card>
  );
}

/** Stat card matching Synthetic Sentinel style */
function StatCard({
  label,
  value,
  icon,
  loading,
  subtitle,
}: {
  label: string;
  value: number | undefined;
  icon: React.ReactNode;
  loading: boolean;
  subtitle?: string;
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
          <>
            <p className="text-2xl font-bold font-mono">
              {(value ?? 0).toLocaleString()}
            </p>
            {subtitle && (
              <p className="text-xs text-muted-foreground/60 mt-1">{subtitle}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DataQualityCard({ stats, sourceConfigCount }: { stats: PipelineStats; sourceConfigCount: number }) {
  const metrics = useMemo(() => {
    const total = stats.totalRecords || 1; // avoid division by zero
    const embeddingPct = ((stats.embeddedRecords / total) * 100).toFixed(1);
    const embeddingWidth = Math.round((stats.embeddedRecords / total) * 100);
    const anchorPct = ((stats.anchoredRecords / total) * 100).toFixed(1);
    const anchorWidth = Math.round((stats.anchoredRecords / total) * 100);

    const otherCount = stats.byCredentialType['OTHER']?.total ?? 0;
    const totalAnchored = Object.values(stats.byCredentialType).reduce((sum, c) => sum + c.total, 0);
    const classifiedPct = totalAnchored > 0
      ? (((totalAnchored - otherCount) / totalAnchored) * 100).toFixed(1)
      : '100.0';
    const classifiedWidth = totalAnchored > 0
      ? Math.round(((totalAnchored - otherCount) / totalAnchored) * 100)
      : 100;

    const activeSources = Object.keys(stats.bySource).length;
    const sourcePct = Math.round((activeSources / sourceConfigCount) * 100);

    return {
      embeddingPct, embeddingWidth, anchorPct, anchorWidth,
      classifiedPct, classifiedWidth, otherCount,
      activeSources, sourcePct,
      unembedded: stats.totalRecords - stats.embeddedRecords,
      inactiveSources: sourceConfigCount - activeSources,
    };
  }, [stats, sourceConfigCount]);

  return (
    <Card className="border-[#00d4ff]/10 bg-transparent">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-[#00d4ff]" />
          Training Data Quality
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <QualityMetric label="Embedding Coverage" value={`${metrics.embeddingPct}%`} width={metrics.embeddingWidth} color="bg-purple-400" detail={`${metrics.unembedded.toLocaleString()} unembedded`} />
          <QualityMetric label="Anchoring Coverage" value={`${metrics.anchorPct}%`} width={metrics.anchorWidth} color="bg-emerald-400" detail={`${stats.pendingRecords.toLocaleString()} pending anchoring`} />
          <QualityMetric label="Type Classification" value={`${metrics.classifiedPct}%`} width={metrics.classifiedWidth} color="bg-[#00d4ff]" detail={`${metrics.otherCount.toLocaleString()} unclassified (OTHER)`} />
          <QualityMetric label="Data Sources Active" value={`${metrics.activeSources} / ${sourceConfigCount}`} width={metrics.sourcePct} color="bg-amber-400" detail={`${metrics.inactiveSources} sources not yet ingested`} />
        </div>
      </CardContent>
    </Card>
  );
}

function QualityMetric({ label, value, width, color, detail }: {
  label: string; value: string; width: number; color: string; detail: string;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-mono font-semibold">{value}</div>
      <div className="w-full bg-muted rounded-full h-1.5">
        <div className={`${color} h-1.5 rounded-full`} style={{ width: `${width}%` }} />
      </div>
      <div className="text-[10px] text-muted-foreground">{detail}</div>
    </div>
  );
}

function JobButton({ path, label, icon, status, onTrigger }: {
  path: string;
  label: string;
  icon: React.ReactNode;
  status: Record<string, 'idle' | 'running' | 'done' | 'error'>;
  onTrigger: (path: string) => void;
}) {
  const s = status[path] ?? 'idle';
  return (
    <Button
      variant="outline"
      size="sm"
      className="justify-start border-[#00d4ff]/20 hover:bg-[#00d4ff]/5 text-xs"
      disabled={s === 'running'}
      onClick={() => onTrigger(path)}
    >
      {s === 'running' ? (
        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
      ) : (
        <span className="mr-2">{icon}</span>
      )}
      {label}
      {s === 'done' && <Badge variant="secondary" className="ml-auto text-emerald-400 text-[10px]">Done</Badge>}
      {s === 'error' && <Badge variant="destructive" className="ml-auto text-[10px]">Error</Badge>}
    </Button>
  );
}
