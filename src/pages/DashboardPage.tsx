/**
 * Dashboard Page
 *
 * Main authenticated view showing user's secured records.
 * Serves both INDIVIDUAL and ORG_ADMIN users.
 * Uses approved terminology per Constitution.
 *
 * @see P3-TS-01 — Wired to real Supabase queries via useAnchors hook
 * @see MVP-09 — Search, filter, and pagination
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, CheckCircle, Clock, Plus, Search, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useAnchors } from '@/hooks/useAnchors';
import { useRevokeAnchor } from '@/hooks/useRevokeAnchor';
import { useChecklist } from '@/hooks/useChecklist';
import { AppShell } from '@/components/layout';
import { StatCard, EmptyState, ProfileCard } from '@/components/dashboard';
import { SecureDocumentDialog } from '@/components/anchor';
import { IssueCredentialForm } from '@/components/organization';
import { RecordsList, type Record } from '@/components/records';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ROUTES, recordDetailPath } from '@/lib/routes';
import { isPlatformAdmin } from '@/lib/platform';
import { RECORDS_LIST_LABELS, ONBOARDING_GUIDANCE_LABELS, SECURE_DIALOG_LABELS, DISCLAIMER_LABELS } from '@/lib/copy';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { CreditUsageWidget } from '@/components/dashboard/CreditUsageWidget';
import { ComplianceScoreCard } from '@/components/compliance/ComplianceScoreCard';
import { AuditMyOrganizationButton } from '@/components/compliance/AuditMyOrganizationButton';
import { UsageWidget } from '@/components/billing/UsageWidget';
import { CleCreditWidget } from '@/components/dashboard/CleCreditWidget';
import { GettingStartedChecklist } from '@/components/onboarding/GettingStartedChecklist';
import { useOrganization } from '@/hooks/useOrganization';
import { supabase } from '@/lib/supabase';

const PAGE_SIZES = [10, 25, 50] as const;
type StatusFilter = 'ALL' | 'PENDING' | 'SECURED' | 'REVOKED' | 'EXPIRED';

export function DashboardPage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading, updateProfile } = useProfile();
  const { records, loading: recordsLoading, refreshAnchors } = useAnchors();
  const { revokeAnchor, error: revokeError, clearError: clearRevokeError } = useRevokeAnchor();
  const { organization } = useOrganization(profile?.org_id);
  const [secureDialogOpen, setSecureDialogOpen] = useState(false);
  const [issueDialogOpen, setIssueDialogOpen] = useState(false);
  const [disclaimerAccepting, setDisclaimerAccepting] = useState(false);
  const [disclaimerDismissed, setDisclaimerDismissed] = useState(false);
  const [recordsExpanded, setRecordsExpanded] = useState(true);
  const recordsSectionRef = useRef<HTMLDivElement>(null);

  const needsDisclaimer = !disclaimerDismissed && !profileLoading && profile && !profile.disclaimer_accepted_at;

  const handleAcceptDisclaimer = useCallback(async () => {
    setDisclaimerAccepting(true);
    try {
      // Dismiss immediately — disclaimer is informational, not a legal gate.
      // If the DB update fails, the dialog will re-appear next session.
      setDisclaimerDismissed(true);
      await updateProfile({ disclaimer_accepted_at: new Date().toISOString() });
    } catch {
      // Swallow errors — dismissal is already applied locally
    } finally {
      setDisclaimerAccepting(false);
    }
  }, [updateProfile]);

  // Search, filter, pagination state (MVP-09)
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(10);

  // DEBT-5: Consolidated checklist state (replaces 3 scattered useEffect blocks)
  const { hasTemplates, hasBillingPlan } = useChecklist(
    user?.id,
    profile?.org_id,
    profile?.role,
  );

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  // Realtime subscription in useAnchors handles INSERT — no manual refresh needed
  const handleSecureSuccess = useCallback(() => {}, []);

  const handleViewRecord = useCallback((record: Record) => {
    navigate(recordDetailPath(record.id));
  }, [navigate]);

  const handleDownloadProof = useCallback((_record: Record) => {
    // Proof download is implemented in P7-TS-07
  }, []);

  const handleRevokeRecord = useCallback(async (record: Record) => {
    const success = await revokeAnchor(record.id);
    if (success) {
      await refreshAnchors();
    }
  }, [revokeAnchor, refreshAnchors]);

  // Privacy toggle handler (ProfileCard)
  const handleTogglePrivacy = useCallback(async (isPublic: boolean) => {
    await updateProfile({ is_public_profile: isPublic });
  }, [updateProfile]);

  // Stat card click handlers — scroll to records and apply filter
  const handleStatClick = useCallback((filter: StatusFilter) => {
    setStatusFilter(filter);
    setCurrentPage(1);
    setRecordsExpanded(true);
    // requestAnimationFrame guarantees DOM has updated before scroll
    requestAnimationFrame(() => {
      recordsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);

  // Filtered + searched records (MVP-09)
  const filteredRecords = useMemo(() => {
    let result = records;

    if (statusFilter !== 'ALL') {
      result = result.filter(r => r.status === statusFilter);
    }

    if (searchQuery.trim()) {
      const query = searchQuery.trim().toLowerCase();
      result = result.filter(r =>
        r.filename.toLowerCase().includes(query) ||
        (r.fingerprint ?? '').toLowerCase().includes(query)
      );
    }

    return result;
  }, [records, statusFilter, searchQuery]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filteredRecords.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedRecords = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filteredRecords.slice(start, start + pageSize);
  }, [filteredRecords, safePage, pageSize]);

  const paginationStart = filteredRecords.length === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const paginationEnd = Math.min(safePage * pageSize, filteredRecords.length);

  // Reset page when search/filter changes
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    setCurrentPage(1);
  }, []);

  const handleStatusFilterChange = useCallback((value: string) => {
    setStatusFilter(value as StatusFilter);
    setCurrentPage(1);
  }, []);

  const handlePageSizeChange = useCallback((value: string) => {
    setPageSize(Number(value));
    setCurrentPage(1);
  }, []);

  // PERF: Use SECURITY DEFINER RPCs (migration 0176) instead of 3 separate
  // count queries through RLS. Single RPC call bypasses RLS, uses indexes,
  // returns in <100ms instead of 5s+ timeout on 1.4M row table.
  const [orgStats, setOrgStats] = useState<{ total: number; secured: number; pending: number } | null>(null);
  useEffect(() => {
    if (!user) return;
    async function fetchStats() {
      const rpcName = profile?.role === 'ORG_ADMIN' && profile?.org_id
        ? 'get_org_anchor_stats'
        : 'get_user_anchor_stats';
      const rpcParam = profile?.role === 'ORG_ADMIN' && profile?.org_id
        ? { p_org_id: profile.org_id }
        : { p_user_id: user!.id };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: rpcError } = await (supabase as any).rpc(rpcName, rpcParam);
      if (rpcError) {
        console.error('Dashboard stats RPC error:', rpcError);
        return;
      }
      const result = data ?? {};
      setOrgStats({
        total: result.total ?? 0,
        secured: result.secured ?? 0,
        pending: result.pending ?? 0,
      });
    }
    fetchStats();
  }, [profile?.role, profile?.org_id, user]);

  const stats = orgStats ?? {
    total: records.length,
    secured: records.filter(r => r.status === 'SECURED').length,
    pending: records.filter(r => r.status === 'PENDING').length,
  };
  // PERF: Stat cards use their own loading state (RPC is <100ms).
  // Don't block on the records query which can take 5s+ through RLS.
  const statsLoading = profileLoading || (!orgStats && recordsLoading);

  const loading = profileLoading || recordsLoading;
  const hasRecords = records.length > 0;
  const hasFilteredResults = filteredRecords.length > 0;
  const isFiltering = searchQuery.trim() !== '' || statusFilter !== 'ALL';

  return (
    <AppShell
      user={user}
      profile={profile}
      profileLoading={profileLoading}
      onSignOut={handleSignOut}
      orgName={organization?.display_name}
    >
      {/* Platform Disclaimer Modal (SCRUM-362: show on first login, not buried in settings) */}
      <Dialog open={!!needsDisclaimer}>
        <DialogContent className="sm:max-w-lg" onPointerDownOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>{DISCLAIMER_LABELS.heading}</DialogTitle>
            <DialogDescription className="sr-only">
              Please review and accept the platform disclaimer to continue.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground whitespace-pre-line max-h-[40vh] overflow-y-auto">
              {DISCLAIMER_LABELS.body}
            </p>
            <Button onClick={handleAcceptDisclaimer} disabled={disclaimerAccepting} className="w-full">
              {DISCLAIMER_LABELS.acceptButton}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Profile Card — user profile + verified badge + privacy toggle + org link */}
      <ProfileCard
        profile={profile}
        organization={organization}
        loading={profileLoading}
        onTogglePrivacy={handleTogglePrivacy}
      />

      {/* Stats grid — clickable cards filter My Records */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-3 mb-8">
        <StatCard
          label="Total Records"
          value={stats.total}
          icon={FileText}
          variant="primary"
          loading={statsLoading}
          onClick={() => handleStatClick('ALL')}
        />
        <StatCard
          label="Secured"
          value={stats.secured}
          icon={CheckCircle}
          variant="success"
          loading={statsLoading}
          onClick={() => handleStatClick('SECURED')}
        />
        <StatCard
          label="Pending"
          value={stats.pending}
          icon={Clock}
          variant="warning"
          loading={statsLoading}
          onClick={() => handleStatClick('PENDING')}
        />
      </div>

      {/* NCA-07: Audit My Organization CTA — prominently placed above the fold for ORG_ADMIN */}
      {profile?.role === 'ORG_ADMIN' && (
        <div className="mb-6">
          <AuditMyOrganizationButton />
        </div>
      )}

      {/* Widgets — Compliance Score only for ORG_ADMIN, Usage + Credit for all */}
      <div className={`grid gap-4 grid-cols-1 mb-8 ${profile?.role === 'ORG_ADMIN' ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
        {profile?.role === 'ORG_ADMIN' && <ComplianceScoreCard />}
        <UsageWidget />
        <CreditUsageWidget />
      </div>

      {/* CLE Credit Summary (visible only when user has CLE records) */}
      <div className="mb-8">
        <CleCreditWidget />
      </div>

      {/* Getting started checklist (UF-10) — hidden for platform admins */}
      {profile?.role && !isPlatformAdmin(user?.email) && (
        <div className="mb-8">
          <GettingStartedChecklist
            role={profile.role as 'ORG_ADMIN' | 'INDIVIDUAL'}
            context={{
              hasRecords: records.length > 0,
              hasTemplates,
              hasBillingPlan,
            }}
          />
        </div>
      )}

      {/* Revoke error */}
      {revokeError && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription className="flex items-center justify-between">
            <span>{revokeError}</span>
            <Button variant="ghost" size="sm" onClick={clearRevokeError}>Dismiss</Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Records section — collapsible */}
      <div ref={recordsSectionRef}>
        <Card className="border-white/[0.06] bg-white/[0.015]">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
            <button
              onClick={() => setRecordsExpanded(!recordsExpanded)}
              className="flex items-center gap-2 hover:text-[#00d4ff] transition-colors"
            >
              {recordsExpanded ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
              <CardTitle className="text-[17px] font-semibold">My Records</CardTitle>
            </button>
            <div className="flex gap-2">
              <Button onClick={() => setSecureDialogOpen(true)} className="bg-[#00d4ff] text-[#0a0f14] hover:bg-[#00a3cc] font-medium text-[13px]">
                <Plus className="mr-2 h-4 w-4" />
                {SECURE_DIALOG_LABELS.TITLE}
              </Button>
              {profile?.role === 'ORG_ADMIN' && profile.org_id && (
                <Button onClick={() => setIssueDialogOpen(true)} variant="outline" className="font-medium text-[13px]">
                  <Plus className="mr-2 h-4 w-4" />
                  {ONBOARDING_GUIDANCE_LABELS.EMPTY_ORG_RECORDS_CTA}
                </Button>
              )}
            </div>
          </CardHeader>

          {recordsExpanded && (
            <>
              {/* Search + Filter controls (MVP-09) */}
              {hasRecords && (
                <div className="px-6 pb-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        placeholder={RECORDS_LIST_LABELS.SEARCH_PLACEHOLDER}
                        value={searchQuery}
                        onChange={(e) => handleSearchChange(e.target.value)}
                        className="pl-9"
                      />
                    </div>
                    <Select value={statusFilter} onValueChange={handleStatusFilterChange}>
                      <SelectTrigger className="w-full sm:w-[160px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ALL">{RECORDS_LIST_LABELS.FILTER_ALL}</SelectItem>
                        <SelectItem value="PENDING">{RECORDS_LIST_LABELS.FILTER_PENDING}</SelectItem>
                        <SelectItem value="SECURED">{RECORDS_LIST_LABELS.FILTER_SECURED}</SelectItem>
                        <SelectItem value="REVOKED">{RECORDS_LIST_LABELS.FILTER_REVOKED}</SelectItem>
                        <SelectItem value="EXPIRED">{RECORDS_LIST_LABELS.FILTER_EXPIRED}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              <Separator />
              <CardContent className="pt-0">
                {!loading && !hasRecords ? (
                  <EmptyState
                    title={profile?.role === 'ORG_ADMIN'
                      ? ONBOARDING_GUIDANCE_LABELS.EMPTY_ORG_RECORDS
                      : ONBOARDING_GUIDANCE_LABELS.EMPTY_INDIVIDUAL_RECORDS}
                    description={profile?.role === 'ORG_ADMIN'
                      ? ONBOARDING_GUIDANCE_LABELS.EMPTY_ORG_RECORDS_DESC
                      : ONBOARDING_GUIDANCE_LABELS.EMPTY_INDIVIDUAL_RECORDS_DESC}
                    actionLabel={profile?.role === 'ORG_ADMIN'
                      ? ONBOARDING_GUIDANCE_LABELS.EMPTY_ORG_RECORDS_CTA
                      : ONBOARDING_GUIDANCE_LABELS.EMPTY_INDIVIDUAL_RECORDS_CTA}
                    onAction={() => {
                      if (profile?.role === 'ORG_ADMIN' && profile.org_id) {
                        setIssueDialogOpen(true);
                      } else {
                        setSecureDialogOpen(true);
                      }
                    }}
                  />
                ) : !loading && isFiltering && !hasFilteredResults ? (
                  <div className="py-12 text-center">
                    <Search className="mx-auto h-8 w-8 text-muted-foreground/50 mb-3" />
                    <p className="text-sm font-medium text-muted-foreground">
                      {RECORDS_LIST_LABELS.NO_RESULTS}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {RECORDS_LIST_LABELS.NO_RESULTS_DESC}
                    </p>
                  </div>
                ) : (
                  <RecordsList
                    records={paginatedRecords}
                    loading={recordsLoading}
                    onViewRecord={handleViewRecord}
                    onDownloadProof={handleDownloadProof}
                    onRevokeRecord={handleRevokeRecord}
                  />
                )}

                {/* Pagination controls (MVP-09) */}
                {hasRecords && !recordsLoading && filteredRecords.length > 0 && (
                  <div className="flex flex-col gap-3 border-t pt-4 mt-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <span>
                        {RECORDS_LIST_LABELS.SHOWING_RESULTS
                          .replace('{start}', String(paginationStart))
                          .replace('{end}', String(paginationEnd))
                          .replace('{total}', String(filteredRecords.length))}
                      </span>
                      <Select value={String(pageSize)} onValueChange={handlePageSizeChange}>
                        <SelectTrigger className="h-8 w-[70px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PAGE_SIZES.map(size => (
                            <SelectItem key={size} value={String(size)}>{size}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <span className="text-xs">{RECORDS_LIST_LABELS.PAGE_SIZE_LABEL}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                        disabled={safePage <= 1}
                        aria-label="Previous page"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      {Array.from({ length: totalPages }, (_, i) => i + 1)
                        .filter(p => p === 1 || p === totalPages || Math.abs(p - safePage) <= 1)
                        .reduce<(number | 'ellipsis-before')[]>((acc, p, idx, arr) => {
                          if (idx > 0 && arr[idx - 1] !== p - 1) {
                            acc.push(`ellipsis-before-${p}` as 'ellipsis-before');
                          }
                          acc.push(p as unknown as 'ellipsis-before');
                          return acc;
                        }, [])
                        .map((item) =>
                          typeof item === 'string' ? (
                            <span key={item} className="px-2 text-sm text-muted-foreground">...</span>
                          ) : (
                            <Button
                              key={item}
                              variant={(item as number) === safePage ? 'default' : 'outline'}
                              size="sm"
                              className="h-8 w-8 p-0"
                              onClick={() => setCurrentPage(item as number)}
                            >
                              {item as number}
                            </Button>
                          )
                        )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                        disabled={safePage >= totalPages}
                        aria-label="Next page"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </>
          )}
        </Card>
      </div>

      {/* Secure Document Dialog */}
      <SecureDocumentDialog
        open={secureDialogOpen}
        onOpenChange={setSecureDialogOpen}
        onSuccess={handleSecureSuccess}
      />

      {/* SCRUM-500: Issue Credential dialog for ORG_ADMIN users */}
      <IssueCredentialForm
        open={issueDialogOpen}
        onOpenChange={setIssueDialogOpen}
        onSuccess={handleSecureSuccess}
      />

    </AppShell>
  );
}
