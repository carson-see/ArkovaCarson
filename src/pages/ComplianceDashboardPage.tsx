/**
 * Compliance Intelligence Dashboard
 *
 * Unified surface consolidating credential health monitoring,
 * expiry alerts, activity feed, and AI review summary.
 * Links out to existing detail pages (attestations, review queue).
 */

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  ShieldCheck,
  Clock,
  XCircle,
  Link2,
  AlertTriangle,
  CheckCircle,
  Activity,
  ArrowRight,
  FileCheck,
  Ban,
} from 'lucide-react';
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
import { ROUTES } from '@/lib/routes';
import { COMPLIANCE_LABELS } from '@/lib/copy';
import { cn } from '@/lib/utils';
import type { Database } from '@/types/database.types';

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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ComplianceDashboardPage() {
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const orgId = profile?.org_id;

  const [stats, setStats] = useState<HealthStats | null>(null);
  const [expiring, setExpiring] = useState<ExpiringAttestation[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [reviewCount, setReviewCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);

    try {
      const now = new Date().toISOString();
      const thirtyDaysFromNow = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      // Fetch counts in parallel
      const [activeRes, expiringRes, revokedRes, totalRes, anchoredRes] = await Promise.all([
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
      ]);

      setStats({
        activeCount: activeRes.count ?? 0,
        expiringCount: expiringRes.count ?? 0,
        revokedCount: revokedRes.count ?? 0,
        totalCount: totalRes.count ?? 0,
        anchoredCount: anchoredRes.count ?? 0,
      });

      // Fetch expiring attestations detail
      const { data: expiringData } = await supabase
        .from('attestations')
        .select('id, public_id, subject_identifier, attestation_type, attester_name, expires_at, status')
        .eq('attester_org_id', orgId)
        .eq('status', 'ACTIVE')
        .not('expires_at', 'is', null)
        .gte('expires_at', now)
        .lte('expires_at', thirtyDaysFromNow)
        .order('expires_at', { ascending: true })
        .limit(20);

      setExpiring(
        (expiringData ?? []).map((a) => ({
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

      // Fetch recent activity (last 20 attestation events)
      const { data: activityData } = await supabase
        .from('attestations')
        .select('id, subject_identifier, status, updated_at, attestation_type')
        .eq('attester_org_id', orgId)
        .order('updated_at', { ascending: false })
        .limit(20);

      setActivity(
        (activityData ?? []).map((a) => {
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

      // Fetch review queue count (pending items)
      const { count: pendingReviewCount } = await supabase
        .from('review_queue_items')
        .select('*', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .eq('status', 'PENDING');

      setReviewCount(pendingReviewCount ?? 0);
    } catch {
      // Silently handle - stats will show as 0
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const anchoredRate = stats && stats.totalCount > 0
    ? Math.round((stats.anchoredCount / stats.totalCount) * 100)
    : 0;

  return (
    <AppShell user={user ?? undefined} onSignOut={signOut} profile={profile ?? undefined} profileLoading={profileLoading}>
      <div className="space-y-6 p-4 md:p-6 max-w-7xl mx-auto">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-[#00d4ff]" />
            {COMPLIANCE_LABELS.PAGE_TITLE}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {COMPLIANCE_LABELS.PAGE_SUBTITLE}
          </p>
        </div>

        {/* Section 1: Health Overview Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            title={COMPLIANCE_LABELS.CARD_ACTIVE}
            value={stats?.activeCount}
            icon={<CheckCircle className="h-5 w-5 text-green-400" />}
            loading={loading}
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

        {/* Section 2: Expiring Credentials */}
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
                <ShieldCheck className="h-5 w-5 text-[#00d4ff]" />
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

export default ComplianceDashboardPage;
