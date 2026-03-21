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

import { useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, CheckCircle, Clock, Plus, Shield, Eye, EyeOff, Copy, Check, Search, ChevronLeft, ChevronRight, Upload } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useAnchors } from '@/hooks/useAnchors';
import { useRevokeAnchor } from '@/hooks/useRevokeAnchor';
import { AppShell } from '@/components/layout';
import { StatCard, EmptyState } from '@/components/dashboard';
import { SecureDocumentDialog } from '@/components/anchor';
import { RecordsList, type Record } from '@/components/records';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ROUTES, recordDetailPath } from '@/lib/routes';
import { IDENTITY_LABELS, RECORDS_LIST_LABELS, ONBOARDING_GUIDANCE_LABELS, ORG_PAGE_LABELS, SECURE_DIALOG_LABELS } from '@/lib/copy';
import { CreditUsageWidget } from '@/components/dashboard/CreditUsageWidget';
import { UsageWidget } from '@/components/billing/UsageWidget';
import { GettingStartedChecklist } from '@/components/onboarding/GettingStartedChecklist';
import { useOrganization } from '@/hooks/useOrganization';
import { BulkUploadWizard } from '@/components/upload';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

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
  const [bulkUploadOpen, setBulkUploadOpen] = useState(false);
  const [copiedId, setCopiedId] = useState(false);

  // Search, filter, pagination state (MVP-09)
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(10);

  const handleCopyId = useCallback(async () => {
    if (profile?.public_id) {
      await navigator.clipboard.writeText(profile.public_id);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 2000);
    }
  }, [profile?.public_id]);

  // Privacy toggle — reads from DB, persisted via updateProfile
  const isPublicProfile = useMemo(() => profile?.is_public_profile ?? false, [profile]);
  const handleTogglePublicProfile = useCallback(async (checked: boolean) => {
    await updateProfile({ is_public_profile: checked });
  }, [updateProfile]);

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  const handleSecureSuccess = useCallback(async () => {
    await refreshAnchors();
  }, [refreshAnchors]);

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
        r.fingerprint.toLowerCase().includes(query)
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

  const stats = {
    total: records.length,
    secured: records.filter(r => r.status === 'SECURED').length,
    pending: records.filter(r => r.status === 'PENDING').length,
  };

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
      {/* Welcome section */}
      <div className="mb-8">
        <h1 className="text-3xl font-black tracking-tighter">
          Welcome back{profile?.full_name ? `, ${profile.full_name.split(' ')[0]}` : ''}
        </h1>
        <p className="text-muted-foreground mt-1 font-mono text-[10px] uppercase tracking-widest">
          Manage and verify your secured documents
        </p>
      </div>

      {/* Stats grid */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-3 mb-8">
        <StatCard
          label="Total Records"
          value={stats.total}
          icon={FileText}
          variant="primary"
          loading={loading}
        />
        <StatCard
          label="Secured"
          value={stats.secured}
          icon={CheckCircle}
          variant="success"
          loading={loading}
        />
        <StatCard
          label="Pending"
          value={stats.pending}
          icon={Clock}
          variant="warning"
          loading={loading}
        />
      </div>

      {/* Usage tracking (UF-06) + Credit usage (MVP-25) */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 mb-8">
        <UsageWidget />
        <CreditUsageWidget />
      </div>

      {/* Getting started checklist (UF-10) */}
      {profile?.role && (
        <div className="mb-8">
          <GettingStartedChecklist
            role={profile.role as 'ORG_ADMIN' | 'INDIVIDUAL'}
            context={{
              hasRecords: records.length > 0,
              hasTemplates: false, // Will be checked by checklist internally in future
              hasBillingPlan: false, // Will be checked by checklist internally in future
            }}
          />
        </div>
      )}

      {/* Privacy toggle */}
      <Card className="mb-8">
        <CardContent className="flex items-center justify-between py-4">
          {profileLoading ? (
            <div className="flex items-center gap-3 w-full">
              <Skeleton className="h-10 w-10 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-64" />
              </div>
              <Skeleton className="h-5 w-9 rounded-full" />
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  {isPublicProfile ? (
                    <Eye className="h-5 w-5 text-primary" />
                  ) : (
                    <EyeOff className="h-5 w-5 text-muted-foreground" />
                  )}
                </div>
                <div className="space-y-0.5">
                  <Label htmlFor="public-profile" className="text-sm font-medium">
                    Public Verification Profile
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {isPublicProfile
                      ? 'Your records can be verified by anyone with the fingerprint'
                      : 'Only you can access your verification records'}
                  </p>
                </div>
              </div>
              <Switch
                id="public-profile"
                checked={isPublicProfile}
                onCheckedChange={handleTogglePublicProfile}
              />
            </>
          )}
        </CardContent>
      </Card>

      {/* Revoke error */}
      {revokeError && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription className="flex items-center justify-between">
            <span>{revokeError}</span>
            <Button variant="ghost" size="sm" onClick={clearRevokeError}>Dismiss</Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Records section */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle className="text-lg font-semibold">My Records</CardTitle>
          <div className="flex gap-2">
            {profile?.role === 'ORG_ADMIN' && (
              <Button variant="outline" onClick={() => setBulkUploadOpen(true)}>
                <Upload className="mr-2 h-4 w-4" />
                {ORG_PAGE_LABELS.BULK_UPLOAD}
              </Button>
            )}
            <Button onClick={() => setSecureDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              {SECURE_DIALOG_LABELS.TITLE}
            </Button>
          </div>
        </CardHeader>

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
              onAction={() => setSecureDialogOpen(true)}
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
      </Card>

      {/* Account info */}
      {profile && (
        <Card className="mt-6">
          <CardContent className="py-4 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <Shield className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-medium">Account</p>
                  <p className="text-sm text-muted-foreground">
                    {profile.role === 'ORG_ADMIN' ? 'Organization Administrator' : 'Individual Account'}
                  </p>
                </div>
              </div>
              <Badge variant="secondary">
                {profile.role === 'ORG_ADMIN' ? 'Org Admin' : 'Individual'}
              </Badge>
            </div>
            {profile.public_id && (
              <>
                <Separator />
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{IDENTITY_LABELS.USER_ID}</p>
                    <p className="text-xs text-muted-foreground">{IDENTITY_LABELS.USER_ID_DESC}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="text-sm font-mono bg-muted rounded px-2 py-1">
                      {profile.public_id}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={handleCopyId}
                    >
                      {copiedId ? (
                        <Check className="h-4 w-4 text-green-600" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                      <span className="sr-only">Copy User ID</span>
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Secure Document Dialog */}
      <SecureDocumentDialog
        open={secureDialogOpen}
        onOpenChange={setSecureDialogOpen}
        onSuccess={handleSecureSuccess}
      />

      {/* Bulk Upload Dialog (ORG_ADMIN only) */}
      <Dialog open={bulkUploadOpen} onOpenChange={setBulkUploadOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{ORG_PAGE_LABELS.BULK_UPLOAD_DIALOG_TITLE}</DialogTitle>
          </DialogHeader>
          <BulkUploadWizard
            onComplete={() => {
              setBulkUploadOpen(false);
              refreshAnchors();
            }}
            onCancel={() => setBulkUploadOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
