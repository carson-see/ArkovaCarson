/**
 * Compliance Intelligence Dashboard
 *
 * Unified surface consolidating credential health monitoring,
 * expiry alerts, activity feed, and AI review summary.
 * Links out to existing detail pages (attestations, review queue).
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { Link } from 'react-router-dom';
import { Clock, XCircle, Link2, AlertTriangle, CheckCircle, Activity, ArrowRight, FileCheck, Ban, Download, BarChart3 } from 'lucide-react';
import { AppShell } from '@/components/layout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { isPlatformAdmin } from '@/lib/platform';
import { ROUTES } from '@/lib/routes';
import { COMPLIANCE_LABELS } from '@/lib/copy';
import { NessieIntelligencePanel } from '@/components/search/NessieIntelligencePanel';
import { cn } from '@/lib/utils';
import { COMPLIANCE_CONTROLS, ALL_FRAMEWORKS, getComplianceControls } from '@/lib/complianceMapping';
import type { Database } from '@/types/database.types';
import { ComplianceScoreGauge } from '@/components/compliance/ComplianceScoreGauge';
import { GradeBadge } from '@/components/compliance/GradeBadge';
import { MissingDocumentsCard } from '@/components/compliance/MissingDocumentsCard';
import { ExpiringDocumentsCard } from '@/components/compliance/ExpiringDocumentsCard';
import { RecommendationsCard } from '@/components/compliance/RecommendationsCard';
import { ProfessionalEducationExportPanel } from '@/components/compliance/ProfessionalEducationExportPanel';
import { useComplianceScore, useJurisdictionRules } from '@/hooks/useComplianceScore';

type Attestation = Database['public']['Tables']['attestations']['Row'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HealthStats {
  activeCount: number;
  expiringCount: number;
  revokedCount: number;
  totalCount: number;
  anchoredCount: number;
}

interface ExpiringAttestation {
  id: string;
  public_id: string;
  subject_identifier: string;
  attestation_type: string;
  attester_name: string;
  expires_at: string;
  status: string;
  daysLeft: number;
}

interface ActivityEvent {
  id: string;
  description: string;
  timestamp: string;
  type: 'created' | 'active' | 'revoked' | 'expired';
  subject: string;
}

type CpeReportingPeriod = 'year-to-date' | 'last-90-days' | 'last-12-months' | 'all-time';

interface OrgCpeRecord {
  id: string;
  status: string;
  category: string;
  provider: string;
  credits: number;
  completedAt: string | null;
}

interface OrgCpeSummaryGroup {
  label: string;
  count: number;
  credits: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysUntil(dateStr: string): number {
  const now = new Date();
  const target = new Date(dateStr);
  const diff = target.getTime() - now.getTime();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatRelativeTime(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(dateStr);
}

function urgencyColor(daysLeft: number): string {
  if (daysLeft <= 7) return 'text-red-400';
  if (daysLeft <= 14) return 'text-yellow-400';
  return 'text-muted-foreground';
}

function urgencyBadge(daysLeft: number): 'destructive' | 'outline' | 'secondary' {
  if (daysLeft <= 7) return 'destructive';
  if (daysLeft <= 14) return 'outline';
  return 'secondary';
}

function eventIcon(type: ActivityEvent['type']) {
  switch (type) {
    case 'created': return <FileCheck className="h-4 w-4 text-blue-400" />;
    case 'active': return <CheckCircle className="h-4 w-4 text-green-400" />;
    case 'revoked': return <Ban className="h-4 w-4 text-red-400" />;
    case 'expired': return <Clock className="h-4 w-4 text-yellow-400" />;
  }
}

function eventDescription(att: Attestation): { description: string; type: ActivityEvent['type'] } {
  if (att.status === 'REVOKED') {
    return { description: COMPLIANCE_LABELS.EVENT_REVOKED, type: 'revoked' };
  }
  if (att.status === 'EXPIRED') {
    return { description: COMPLIANCE_LABELS.EVENT_EXPIRED, type: 'expired' };
  }
  if (att.status === 'ACTIVE') {
    return { description: COMPLIANCE_LABELS.EVENT_ACTIVE, type: 'active' };
  }
  return { description: COMPLIANCE_LABELS.EVENT_CREATED, type: 'created' };
}

function metadataString(metadata: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function metadataNumber(metadata: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
  }
  return 0;
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\w\S*/g, word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function formatCredits(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function normalizeCpeStatus(rowStatus: unknown, metadata: Record<string, unknown>): string {
  const extractedStatus = metadataString(metadata, 'status', 'compliance_status');
  const requiresReview = metadata.requires_manual_review === true || extractedStatus === 'needs_review';
  if (requiresReview) return 'Needs Review';

  if (typeof rowStatus === 'string' && rowStatus.trim()) {
    return titleCase(rowStatus);
  }

  if (extractedStatus) return titleCase(extractedStatus);
  return 'Unknown';
}

function normalizeOrgCpeRecord(row: Record<string, unknown>): OrgCpeRecord | null {
  const metadata = row.cpe_metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const cpeMetadata = metadata as Record<string, unknown>;
  const id = typeof row.id === 'string'
    ? row.id
    : typeof row.public_id === 'string'
      ? row.public_id
      : null;
  if (!id) return null;

  return {
    id,
    status: normalizeCpeStatus(row.status, cpeMetadata),
    category: metadataString(cpeMetadata, 'field_of_study', 'fieldOfStudy', 'category', 'credit_type', 'creditType') ?? 'Uncategorized',
    provider: metadataString(cpeMetadata, 'provider', 'provider_name', 'providerName', 'sponsor', 'issuer_name', 'issuerName') ?? 'Unknown provider',
    credits: metadataNumber(cpeMetadata, 'credit_hours', 'creditHours', 'credits', 'cpe_credits', 'cpeCredits'),
    completedAt: metadataString(cpeMetadata, 'completion_date', 'completionDate', 'completed_at', 'completedAt')
      ?? (typeof row.issued_at === 'string' ? row.issued_at : null),
  };
}

function periodStart(period: CpeReportingPeriod): Date | null {
  const now = new Date();
  if (period === 'year-to-date') {
    return new Date(now.getFullYear(), 0, 1);
  }
  if (period === 'last-90-days') {
    return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  }
  if (period === 'last-12-months') {
    return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  }
  return null;
}

function withinReportingPeriod(record: OrgCpeRecord, period: CpeReportingPeriod): boolean {
  const start = periodStart(period);
  if (!start) return true;
  if (!record.completedAt) return false;
  const completedAt = new Date(record.completedAt);
  return Number.isFinite(completedAt.getTime()) && completedAt >= start;
}

function summarizeBy(records: OrgCpeRecord[], key: keyof Pick<OrgCpeRecord, 'status' | 'category' | 'provider'>): OrgCpeSummaryGroup[] {
  const groups = new Map<string, OrgCpeSummaryGroup>();
  for (const record of records) {
    const label = record[key];
    const existing = groups.get(label) ?? { label, count: 0, credits: 0 };
    existing.count += 1;
    existing.credits += record.credits;
    groups.set(label, existing);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ComplianceDashboardPage() {
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const orgId = profile?.org_id;
  const userId = user?.id;

  // SN2: Restrict to ORG_ADMIN and platform admins
  const isAdmin = profile?.role === 'ORG_ADMIN' || isPlatformAdmin(profile?.email);

  const [stats, setStats] = useState<HealthStats | null>(null);
  const [expiring, setExpiring] = useState<ExpiringAttestation[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [reviewCount, setReviewCount] = useState<number>(0);
  const [coverageData, setCoverageData] = useState<{ securedCount: number; controlIds: Set<string>; typeCounts: Map<string, number> } | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<'pdf' | 'csv' | null>(null);
  const [cpeRecords, setCpeRecords] = useState<OrgCpeRecord[]>([]);
  const [cpeLoading, setCpeLoading] = useState(true);
  const [cpeError, setCpeError] = useState<string | null>(null);
  const [cpeReportingPeriod, setCpeReportingPeriod] = useState<CpeReportingPeriod>('year-to-date');

  // NCE: Compliance scoring state
  const [selectedJurisdiction, setSelectedJurisdiction] = useState('US-CA');
  const [selectedIndustry, setSelectedIndustry] = useState('accounting');
  const { jurisdictions, industries } = useJurisdictionRules();
  const { scoreData, gapData, loading: scoreLoading } = useComplianceScore(selectedJurisdiction, selectedIndustry);

  const fetchData = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);

    try {
      const now = new Date().toISOString();
      const thirtyDaysFromNow = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      // Fetch all data in parallel (was: 5 counts parallel + 3 sequential)
      const [
        activeRes, expiringRes, revokedRes, totalRes, anchoredRes,
        expiringDetailRes, activityRes, reviewRes, securedAnchorsRes,
      ] = await Promise.all([
        // Active count
        supabase
          .from('attestations')
          .select('*', { count: 'exact', head: true })
          .eq('attester_org_id', orgId)
          .eq('status', 'ACTIVE'),
        // Expiring within 30 days
        supabase
          .from('attestations')
          .select('*', { count: 'exact', head: true })
          .eq('attester_org_id', orgId)
          .eq('status', 'ACTIVE')
          .not('expires_at', 'is', null)
          .gte('expires_at', now)
          .lte('expires_at', thirtyDaysFromNow),
        // Recently revoked (last 30 days)
        supabase
          .from('attestations')
          .select('*', { count: 'exact', head: true })
          .eq('attester_org_id', orgId)
          .eq('status', 'REVOKED')
          .gte('revoked_at', thirtyDaysAgo),
        // Total
        supabase
          .from('attestations')
          .select('*', { count: 'exact', head: true })
          .eq('attester_org_id', orgId),
        // Anchored (has chain_tx_id)
        supabase
          .from('attestations')
          .select('*', { count: 'exact', head: true })
          .eq('attester_org_id', orgId)
          .not('chain_tx_id', 'is', null),
        // Expiring attestations detail
        supabase
          .from('attestations')
          .select('id, public_id, subject_identifier, attestation_type, attester_name, expires_at, status')
          .eq('attester_org_id', orgId)
          .eq('status', 'ACTIVE')
          .not('expires_at', 'is', null)
          .gte('expires_at', now)
          .lte('expires_at', thirtyDaysFromNow)
          .order('expires_at', { ascending: true })
          .limit(20),
        // Recent activity (last 20 attestation events)
        supabase
          .from('attestations')
          .select('id, subject_identifier, status, updated_at, attestation_type')
          .eq('attester_org_id', orgId)
          .order('updated_at', { ascending: false })
          .limit(20),
        // Review queue count (pending items)
        supabase
          .from('review_queue_items')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .eq('status', 'PENDING'),
        // Secured anchors with credential types for coverage analysis (CML-04)
        // compliance_controls column from migration 0137 (not yet in generated types)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase.from('anchors') as any)
          .select('credential_type, compliance_controls')
          .eq('org_id', orgId)
          .eq('status', 'SECURED')
          .limit(500),
      ]);

      setStats({
        activeCount: activeRes.count ?? 0,
        expiringCount: expiringRes.count ?? 0,
        revokedCount: revokedRes.count ?? 0,
        totalCount: totalRes.count ?? 0,
        anchoredCount: anchoredRes.count ?? 0,
      });

      setExpiring(
        (expiringDetailRes.data ?? []).map((a) => ({
          id: a.id,
          public_id: a.public_id,
          subject_identifier: a.subject_identifier,
          attestation_type: a.attestation_type,
          attester_name: a.attester_name,
          expires_at: a.expires_at!,
          status: a.status,
          daysLeft: daysUntil(a.expires_at!),
        }))
      );

      setActivity(
        (activityRes.data ?? []).map((a) => {
          const evt = eventDescription(a as Attestation);
          return {
            id: a.id,
            description: evt.description,
            type: evt.type,
            timestamp: a.updated_at,
            subject: a.subject_identifier,
          };
        })
      );

      setReviewCount(reviewRes.count ?? 0);

      // CML-04: Compute framework coverage from secured anchors
      const securedAnchors = securedAnchorsRes.data ?? [];
      const allControlIds = new Set<string>();
      const typeCounts = new Map<string, number>();
      for (const anchor of securedAnchors) {
        const ct = (anchor as { credential_type?: string | null }).credential_type ?? 'OTHER';
        typeCounts.set(ct, (typeCounts.get(ct) ?? 0) + 1);
        // Use stored controls if available, otherwise compute
        const stored = (anchor as { compliance_controls?: string[] | null }).compliance_controls;
        const controls = (stored && Array.isArray(stored) && stored.length > 0)
          ? stored
          : getComplianceControls(ct, true).map(c => c.id);
        for (const id of controls) allControlIds.add(id);
      }
      setCoverageData({
        securedCount: securedAnchors.length,
        controlIds: allControlIds,
        typeCounts,
      });
    } catch {
      // Silently handle - stats will show as 0
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async data fetch; setState is post-await
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    let cancelled = false;
    async function fetchCpeRecords() {
      if (!orgId) {
        setCpeRecords([]);
        setCpeLoading(false);
        return;
      }

      setCpeLoading(true);
      setCpeError(null);
      try {
        // New CPE summary endpoint is not present in the worker contract yet;
        // use the same org-scoped anchors read pattern as the coverage section.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await (supabase.from('anchors') as any)
          .select('id, public_id, status, issued_at, credential_type, cpe_metadata')
          .eq('org_id', orgId)
          .eq('credential_type', 'CPE')
          .not('cpe_metadata', 'is', null)
          .order('issued_at', { ascending: false })
          .limit(1000);

        if (cancelled) return;
        if (res.error) {
          setCpeError('Unable to load CPE records.');
          setCpeRecords([]);
          return;
        }

        const rows = Array.isArray(res.data) ? res.data : [];
        setCpeRecords(
          rows
            .map((row: Record<string, unknown>) => normalizeOrgCpeRecord(row))
            .filter((record: OrgCpeRecord | null): record is OrgCpeRecord => record !== null),
        );
      } catch {
        if (!cancelled) {
          setCpeError('Unable to load CPE records.');
          setCpeRecords([]);
        }
      } finally {
        if (!cancelled) setCpeLoading(false);
      }
    }

    void fetchCpeRecords();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const filteredCpeRecords = useMemo(
    () => cpeRecords.filter((record) => withinReportingPeriod(record, cpeReportingPeriod)),
    [cpeRecords, cpeReportingPeriod],
  );

  const cpeTotalCredits = useMemo(
    () => filteredCpeRecords.reduce((sum, record) => sum + record.credits, 0),
    [filteredCpeRecords],
  );

  const cpeStatusSummary = useMemo(() => summarizeBy(filteredCpeRecords, 'status'), [filteredCpeRecords]);
  const cpeCategorySummary = useMemo(() => summarizeBy(filteredCpeRecords, 'category'), [filteredCpeRecords]);
  const cpeProviderSummary = useMemo(() => summarizeBy(filteredCpeRecords, 'provider'), [filteredCpeRecords]);

  const anchoredRate = stats && stats.totalCount > 0
    ? Math.round((stats.anchoredCount / stats.totalCount) * 100)
    : 0;

  // CML-04: Framework coverage computation
  const allFrameworks = ALL_FRAMEWORKS;
  const coveredFrameworks = new Set<string>();
  const coveredControls: Array<{ id: string; framework: string; label: string; description: string }> = [];
  const missingControls: Array<{ id: string; framework: string; label: string; description: string }> = [];

  if (coverageData) {
    for (const [id, ctrl] of Object.entries(COMPLIANCE_CONTROLS)) {
      if (coverageData.controlIds.has(id)) {
        coveredFrameworks.add(ctrl.framework);
        coveredControls.push({ id, framework: ctrl.framework, label: ctrl.label, description: ctrl.description });
      } else {
        missingControls.push({ id, framework: ctrl.framework, label: ctrl.label, description: ctrl.description });
      }
    }
  }

  // Export handler
  async function handleExport(format: 'pdf' | 'csv') {
    if (!user || exporting) return;
    setExporting(format);
    try {
      const session = await supabase.auth.getSession();
      const jwt = session.data.session?.access_token;
      if (!jwt) return;

      const workerUrl = import.meta.env.VITE_WORKER_URL || 'http://localhost:3001';
      const res = await fetch(`${workerUrl}/api/v1/audit-export/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwt}`,
        },
        body: JSON.stringify({ format, limit: 500 }),
      });

      if (!res.ok) throw new Error('Export failed');

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `arkova-audit-batch.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // Silently handle — user sees button reset
    } finally {
      setExporting(null);
    }
  }

  // SN2: Only ORG_ADMIN and platform admins can access
  if (!profileLoading && !isAdmin) {
    return (
      <AppShell user={user ?? undefined} onSignOut={signOut} profile={profile ?? undefined} profileLoading={profileLoading}>
        <div className="flex flex-col items-center justify-center min-h-[60vh] text-center p-6">
          <ArkovaIcon className="h-12 w-12 text-muted-foreground/30 mb-4" />
          <h1 className="text-xl font-semibold text-foreground mb-2">Access Restricted</h1>
          <p className="text-sm text-muted-foreground max-w-md">
            The Compliance Intelligence dashboard is available to organization administrators.
            Contact your admin for access.
          </p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell user={user ?? undefined} onSignOut={signOut} profile={profile ?? undefined} profileLoading={profileLoading}>
      <div className="space-y-6 p-4 md:p-6 max-w-7xl mx-auto">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <ArkovaIcon className="h-6 w-6 text-[#00d4ff]" />
            {COMPLIANCE_LABELS.PAGE_TITLE}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {COMPLIANCE_LABELS.PAGE_SUBTITLE}
          </p>
        </div>

        {/* NCE: Compliance Score Section */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col md:flex-row items-start md:items-center gap-6">
              {/* Score gauge */}
              <div className="shrink-0">
                {scoreLoading ? (
                  <Skeleton className="h-[120px] w-[120px] rounded-full" />
                ) : scoreData ? (
                  <ComplianceScoreGauge score={scoreData.score} grade={scoreData.grade} size="md" />
                ) : (
                  <div className="h-[120px] w-[120px] rounded-full bg-muted/50 flex items-center justify-center text-sm text-muted-foreground">
                    No data
                  </div>
                )}
              </div>

              {/* Score details + selectors */}
              <div className="flex-1 space-y-3">
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-semibold">Compliance Score</h2>
                  {scoreData && <GradeBadge grade={scoreData.grade} />}
                </div>
                {scoreData && (
                  <p className="text-sm text-muted-foreground">
                    {scoreData.total_present} of {scoreData.total_required} required documents present
                  </p>
                )}

                {/* Jurisdiction + Industry selectors */}
                <div className="flex flex-wrap gap-2">
                  <select
                    value={selectedJurisdiction}
                    onChange={(e) => setSelectedJurisdiction(e.target.value)}
                    className="text-sm border rounded-md px-2 py-1 bg-background"
                  >
                    {jurisdictions.map(j => (
                      <option key={j} value={j}>{j}</option>
                    ))}
                    {jurisdictions.length === 0 && <option value="US-CA">US-CA</option>}
                  </select>
                  <select
                    value={selectedIndustry}
                    onChange={(e) => setSelectedIndustry(e.target.value)}
                    className="text-sm border rounded-md px-2 py-1 bg-background"
                  >
                    {industries.map(i => (
                      <option key={i} value={i}>{i}</option>
                    ))}
                    {industries.length === 0 && <option value="accounting">accounting</option>}
                  </select>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* NCE: Gap Analysis + Expiring + Recommendations */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <MissingDocumentsCard documents={scoreData?.missing_documents ?? []} />
          <ExpiringDocumentsCard documents={scoreData?.expiring_documents ?? []} />
          <RecommendationsCard
            missingRequired={gapData?.missing_required ?? []}
            missingRecommended={gapData?.missing_recommended ?? []}
            summary={gapData?.summary ?? 'Loading compliance analysis...'}
          />
        </div>

        {userId && <ProfessionalEducationExportPanel userId={userId} />}

        {/* Section 0: Nessie Intelligence Query */}
        <NessieIntelligencePanel />

        {/* SCRUM-1862: Organization CPE dashboard */}
        <Card className="bg-card border-border" data-testid="org-cpe-dashboard">
          <CardHeader className="pb-3">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <CardTitle className="text-lg font-semibold flex items-center gap-2">
                  <FileCheck className="h-5 w-5 text-[#00d4ff]" />
                  CPE Dashboard
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-1">
                  Organization-level CPE totals by reporting period, status, category, and provider.
                </p>
              </div>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground md:min-w-[180px]" htmlFor="org-cpe-reporting-period">
                Reporting period
                <select
                  id="org-cpe-reporting-period"
                  value={cpeReportingPeriod}
                  onChange={(event) => setCpeReportingPeriod(event.target.value as CpeReportingPeriod)}
                  className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
                >
                  <option value="year-to-date">Year to date</option>
                  <option value="last-90-days">Last 90 days</option>
                  <option value="last-12-months">Last 12 months</option>
                  <option value="all-time">All time</option>
                </select>
              </label>
            </div>
          </CardHeader>
          <CardContent>
            {cpeLoading ? (
              <div className="space-y-3" role="status" aria-live="polite">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : cpeError ? (
              <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
                <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden="true" />
                {cpeError}
              </div>
            ) : filteredCpeRecords.length === 0 ? (
              <div className="text-center py-8">
                <FileCheck className="h-10 w-10 text-muted-foreground mx-auto mb-2" />
                <p className="text-sm font-medium text-foreground">No CPE records in this period</p>
                <p className="text-xs text-muted-foreground mt-1">CPE summaries appear after secured CPE records are available for the selected period.</p>
              </div>
            ) : (
              <div className="space-y-5">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">CPE Records</p>
                    <p className="text-2xl font-bold text-foreground mt-1">{filteredCpeRecords.length}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Credits Logged</p>
                    <p className="text-2xl font-bold text-foreground mt-1">{formatCredits(cpeTotalCredits)}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Providers</p>
                    <p className="text-2xl font-bold text-foreground mt-1">{cpeProviderSummary.length}</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <CpeSummaryList title="Status" groups={cpeStatusSummary} />
                  <CpeSummaryList title="Category" groups={cpeCategorySummary} />
                  <CpeSummaryList title="Provider" groups={cpeProviderSummary} />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Section 1: Health Overview Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            title={COMPLIANCE_LABELS.CARD_ACTIVE}
            value={stats?.activeCount}
            icon={<CheckCircle className="h-5 w-5 text-green-400" />}
            loading={loading}
            subtitle={COMPLIANCE_LABELS.CARD_ACTIVE_SUBTITLE}
          />
          <StatCard
            title={COMPLIANCE_LABELS.CARD_EXPIRING}
            value={stats?.expiringCount}
            icon={<AlertTriangle className="h-5 w-5 text-yellow-400" />}
            loading={loading}
            highlight={!!stats && stats.expiringCount > 0}
          />
          <StatCard
            title={COMPLIANCE_LABELS.CARD_REVOKED}
            value={stats?.revokedCount}
            icon={<XCircle className="h-5 w-5 text-red-400" />}
            loading={loading}
            subtitle={COMPLIANCE_LABELS.WITHIN_30_DAYS}
          />
          <StatCard
            title={COMPLIANCE_LABELS.CARD_ANCHORED}
            value={anchoredRate}
            icon={<Link2 className="h-5 w-5 text-[#00d4ff]" />}
            loading={loading}
            suffix="%"
          />
        </div>

        {/* Section 2: Regulatory Framework Coverage (CML-04) */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Coverage Overview */}
          <Card className="bg-card border-border lg:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg font-semibold flex items-center gap-2">
                <BarChart3 className="h-5 w-5 text-[#00d4ff]" />
                {COMPLIANCE_LABELS.SECTION_COVERAGE}
              </CardTitle>
              <p className="text-xs text-muted-foreground">{COMPLIANCE_LABELS.SECTION_COVERAGE_DESC}</p>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-full" />)}
                </div>
              ) : !coverageData || coverageData.securedCount === 0 ? (
                <div className="text-center py-8">
                  <ArkovaIcon className="h-10 w-10 text-muted-foreground mx-auto mb-2" />
                  <p className="text-sm font-medium text-foreground">{COMPLIANCE_LABELS.COVERAGE_EMPTY}</p>
                  <p className="text-xs text-muted-foreground mt-1">{COMPLIANCE_LABELS.COVERAGE_EMPTY_DESC}</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Framework pills */}
                  <div className="flex flex-wrap gap-2">
                    {allFrameworks.map((fw) => {
                      const covered = coveredFrameworks.has(fw);
                      return (
                        <Badge
                          key={fw}
                          variant={covered ? 'default' : 'outline'}
                          className={cn(
                            'text-xs px-3 py-1',
                            covered && 'bg-[#00d4ff]/10 text-[#00d4ff] border-[#00d4ff]/30',
                            !covered && 'text-muted-foreground opacity-50',
                          )}
                        >
                          {covered && <CheckCircle className="h-3 w-3 mr-1" />}
                          {fw}
                        </Badge>
                      );
                    })}
                  </div>

                  {/* Coverage stats */}
                  <div className="grid grid-cols-3 gap-4 pt-2">
                    <div className="text-center">
                      <p className="text-2xl font-bold text-foreground">{coverageData.securedCount}</p>
                      <p className="text-xs text-muted-foreground">{COMPLIANCE_LABELS.COVERAGE_SECURED}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-bold text-foreground">{coveredControls.length}</p>
                      <p className="text-xs text-muted-foreground">{COMPLIANCE_LABELS.COVERAGE_CONTROLS}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-bold text-[#00d4ff]">{coveredFrameworks.size}/{allFrameworks.length}</p>
                      <p className="text-xs text-muted-foreground">{COMPLIANCE_LABELS.COVERAGE_FRAMEWORKS}</p>
                    </div>
                  </div>

                  {/* Gap analysis — missing controls */}
                  {missingControls.length > 0 && (
                    <div className="pt-2 border-t border-border">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                        Gaps — Controls Not Yet Evidenced
                      </p>
                      <div className="space-y-1">
                        {missingControls.map((ctrl) => (
                          <div key={ctrl.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                            <AlertTriangle className="h-3 w-3 text-yellow-400 shrink-0" />
                            <span className="font-medium">{ctrl.label}</span>
                            <span className="hidden sm:inline">— {ctrl.description}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Export Panel */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg font-semibold flex items-center gap-2">
                <Download className="h-5 w-5 text-[#00d4ff]" />
                {COMPLIANCE_LABELS.EXPORT_AUDIT}
              </CardTitle>
              <p className="text-xs text-muted-foreground">{COMPLIANCE_LABELS.EXPORT_AUDIT_DESC}</p>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={exporting !== null || !coverageData || coverageData.securedCount === 0}
                onClick={() => handleExport('pdf')}
              >
                {exporting === 'pdf' ? 'Generating...' : COMPLIANCE_LABELS.EXPORT_PDF}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={exporting !== null || !coverageData || coverageData.securedCount === 0}
                onClick={() => handleExport('csv')}
              >
                {exporting === 'csv' ? 'Generating...' : COMPLIANCE_LABELS.EXPORT_CSV}
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                GRC-ready format for Vanta, Drata, Anecdotes
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Section 3: Expiring Credentials */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg font-semibold flex items-center gap-2">
              <Clock className="h-5 w-5 text-yellow-400" />
              {COMPLIANCE_LABELS.SECTION_EXPIRING}
              {!loading && expiring.length > 0 && (
                <Badge variant="outline" className="ml-2 text-xs">
                  {expiring.length}
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : expiring.length === 0 ? (
              <div className="text-center py-8">
                <CheckCircle className="h-10 w-10 text-green-400 mx-auto mb-2" />
                <p className="text-sm font-medium text-foreground">{COMPLIANCE_LABELS.EMPTY_EXPIRING}</p>
                <p className="text-xs text-muted-foreground mt-1">{COMPLIANCE_LABELS.EMPTY_EXPIRING_DESC}</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{COMPLIANCE_LABELS.COL_SUBJECT}</TableHead>
                      <TableHead>{COMPLIANCE_LABELS.COL_TYPE}</TableHead>
                      <TableHead>{COMPLIANCE_LABELS.COL_ATTESTER}</TableHead>
                      <TableHead>{COMPLIANCE_LABELS.COL_EXPIRES}</TableHead>
                      <TableHead>{COMPLIANCE_LABELS.COL_DAYS_LEFT}</TableHead>
                      <TableHead className="text-right">{COMPLIANCE_LABELS.COL_ACTION}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {expiring.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="font-medium truncate max-w-[200px]">
                          {item.subject_identifier}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="text-xs">
                            {item.attestation_type}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground truncate max-w-[150px]">
                          {item.attester_name}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDate(item.expires_at)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={urgencyBadge(item.daysLeft)}>
                            <span className={cn('font-mono text-xs', urgencyColor(item.daysLeft))}>
                              {item.daysLeft}d
                            </span>
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" asChild>
                            <Link to={`/verify/attestation/${item.public_id}`}>
                              {COMPLIANCE_LABELS.ACTION_VIEW}
                            </Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Bottom row: Activity + Review Summary side by side */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Section 3: Recent Activity Feed */}
          <Card className="bg-card border-border lg:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg font-semibold flex items-center gap-2">
                <Activity className="h-5 w-5 text-[#00d4ff]" />
                {COMPLIANCE_LABELS.SECTION_ACTIVITY}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="space-y-3">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : activity.length === 0 ? (
                <div className="text-center py-8">
                  <Activity className="h-10 w-10 text-muted-foreground mx-auto mb-2" />
                  <p className="text-sm font-medium text-foreground">{COMPLIANCE_LABELS.EMPTY_ACTIVITY}</p>
                  <p className="text-xs text-muted-foreground mt-1">{COMPLIANCE_LABELS.EMPTY_ACTIVITY_DESC}</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {activity.map((event) => (
                    <div
                      key={event.id}
                      className="flex items-center gap-3 px-2 py-2.5 rounded-md hover:bg-muted/50 transition-colors"
                    >
                      <div className="shrink-0">{eventIcon(event.type)}</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground">
                          <span className="font-medium">{event.description}</span>
                          {' — '}
                          <span className="text-muted-foreground truncate">{event.subject}</span>
                        </p>
                      </div>
                      <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
                        {formatRelativeTime(event.timestamp)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {!loading && activity.length > 0 && (
                <div className="mt-4 pt-3 border-t border-border">
                  <Button variant="ghost" size="sm" asChild className="w-full">
                    <Link to={ROUTES.ATTESTATIONS} className="flex items-center justify-center gap-2">
                      View all credentials
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Section 4: AI Review Summary */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg font-semibold flex items-center gap-2">
                <ArkovaIcon className="h-5 w-5 text-[#00d4ff]" />
                {COMPLIANCE_LABELS.SECTION_REVIEW}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-24 w-full" />
              ) : (
                <div className="space-y-4">
                  <div className="text-center py-4">
                    <p className="text-3xl font-bold text-foreground">{reviewCount}</p>
                    <p className="text-sm text-muted-foreground mt-1">{COMPLIANCE_LABELS.REVIEW_PENDING}</p>
                  </div>
                  <Button variant="outline" size="sm" asChild className="w-full">
                    <Link to={ROUTES.REVIEW_QUEUE} className="flex items-center justify-center gap-2">
                      {COMPLIANCE_LABELS.REVIEW_LINK}
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                  <Button variant="outline" size="sm" asChild className="w-full">
                    <Link to={ROUTES.AI_REPORTS} className="flex items-center justify-center gap-2">
                      View AI Reports
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Stat Card Sub-Component
// ---------------------------------------------------------------------------

interface StatCardProps {
  title: string;
  value: number | undefined;
  icon: React.ReactNode;
  loading: boolean;
  highlight?: boolean;
  subtitle?: string;
  suffix?: string;
}

function StatCard({ title, value, icon, loading, highlight, subtitle, suffix }: Readonly<StatCardProps>) {
  return (
    <Card className={cn(
      'bg-card border-border',
      highlight && 'border-yellow-500/40'
    )}>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{title}</p>
            {loading ? (
              <Skeleton className="h-8 w-16 mt-1" />
            ) : (
              <p className="text-2xl font-bold text-foreground mt-1">
                {value ?? 0}{suffix}
              </p>
            )}
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
            )}
          </div>
          <div className="shrink-0">{icon}</div>
        </div>
      </CardContent>
    </Card>
  );
}

interface CpeSummaryListProps {
  title: string;
  groups: OrgCpeSummaryGroup[];
}

function CpeSummaryList({ title, groups }: Readonly<CpeSummaryListProps>) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">{title}</p>
      <div className="space-y-2">
        {groups.slice(0, 5).map((group) => (
          <div key={group.label} className="flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-foreground">{group.label}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {group.count} / {formatCredits(group.credits)} credits
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default ComplianceDashboardPage;
