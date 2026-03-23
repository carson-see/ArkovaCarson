/**
 * Unified Documents Page
 *
 * Merges My Records, My Credentials, and Attestations into a single
 * tabbed view. Auto-classifies items by type so users don't have to
 * pick a category.
 *
 * Tabs: All / My Records / Issued to Me / Attestations
 *
 * @see Session 10 — Sprint A usability overhaul
 */

import { useState, useCallback, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  FileText,
  CheckCircle,
  Clock,
  Plus,
  Search,
  Filter,
  XCircle,
  AlertTriangle,
  MoreHorizontal,
  Eye,
  Download,
  Loader2,
  GraduationCap,
  Award,
  Building2,
  ExternalLink,
  Shield,
  Inbox,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useAnchors } from '@/hooks/useAnchors';
import { useMyCredentials, type ReceivedCredential } from '@/hooks/useMyCredentials';
import { useRevokeAnchor } from '@/hooks/useRevokeAnchor';
import { supabase } from '@/lib/supabase';
import { AppShell } from '@/components/layout';
import { SecureDocumentDialog } from '@/components/anchor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ROUTES, recordDetailPath, verifyPath } from '@/lib/routes';
import { CREDENTIAL_TYPE_LABELS, DOCUMENTS_PAGE_LABELS } from '@/lib/copy';
import type { Record as AnchorRecord } from '@/components/records';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DocumentTab = 'all' | 'records' | 'credentials' | 'attestations';
type StatusFilter = 'ALL' | 'PENDING' | 'SUBMITTED' | 'SECURED' | 'REVOKED' | 'EXPIRED' | 'ACTIVE';

interface Attestation {
  id: string;
  public_id: string;
  attestation_type: string;
  status: string;
  subject_type: string;
  subject_identifier: string;
  attester_name: string;
  attester_type: string;
  summary: string | null;
  created_at: string;
  expires_at: string | null;
}

/** Unified document item for the "All" tab */
interface UnifiedDocumentItem {
  type: 'record' | 'credential' | 'attestation';
  id: string;
  title: string;
  subtitle: string | null;
  status: string;
  date: string;
  /** For records: navigate to detail. For credentials: verify link. For attestations: verify link. */
  action: () => void;
}

// ---------------------------------------------------------------------------
// Status config
// ---------------------------------------------------------------------------

const statusConfig: Record<string, { label: string; variant: 'warning' | 'secondary' | 'success' | 'destructive' | 'default'; icon: React.ElementType }> = {
  PENDING: { label: 'Pending', variant: 'warning', icon: Clock },
  SUBMITTED: { label: 'Awaiting Confirmation', variant: 'secondary', icon: Loader2 },
  SECURED: { label: 'Secured', variant: 'success', icon: CheckCircle },
  REVOKED: { label: 'Revoked', variant: 'secondary', icon: XCircle },
  EXPIRED: { label: 'Expired', variant: 'secondary', icon: AlertTriangle },
  ACTIVE: { label: 'Active', variant: 'success', icon: CheckCircle },
  DRAFT: { label: 'Draft', variant: 'secondary', icon: Clock },
  CHALLENGED: { label: 'Challenged', variant: 'warning', icon: AlertTriangle },
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function DocumentsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();

  // Data hooks
  const { records, loading: recordsLoading, refreshAnchors } = useAnchors();
  const { credentials, loading: credentialsLoading } = useMyCredentials();
  const { revokeAnchor, error: revokeError, clearError: clearRevokeError } = useRevokeAnchor();

  // Attestations (inline fetch like AttestationsPage)
  const [attestations, setAttestations] = useState<Attestation[]>([]);
  const [attestationsLoading, setAttestationsLoading] = useState(true);

  // UI state
  const [secureDialogOpen, setSecureDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');

  // Tab from URL search params
  const tabParam = searchParams.get('tab');
  const activeTab: DocumentTab = (['all', 'records', 'credentials', 'attestations'] as const).includes(tabParam as DocumentTab)
    ? (tabParam as DocumentTab)
    : 'all';

  const setActiveTab = (tab: DocumentTab) => {
    setSearchParams(tab === 'all' ? {} : { tab }, { replace: true });
    setStatusFilter('ALL');
    setSearchQuery('');
  };

  // Fetch attestations
  const fetchAttestations = useCallback(async () => {
    setAttestationsLoading(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from('attestations')
        .select('id, public_id, attestation_type, status, subject_type, subject_identifier, attester_name, attester_type, summary, created_at, expires_at')
        .order('created_at', { ascending: false })
        .limit(100);
      if (!error && data) {
        setAttestations(data as Attestation[]);
      }
    } catch {
      // Fetch failed silently
    } finally {
      setAttestationsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAttestations();
  }, [fetchAttestations]);

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  const handleSecureSuccess = useCallback(async () => {
    await refreshAnchors();
  }, [refreshAnchors]);

  const handleRevokeRecord = useCallback(async (record: AnchorRecord) => {
    const success = await revokeAnchor(record.id);
    if (success) {
      await refreshAnchors();
    }
  }, [revokeAnchor, refreshAnchors]);

  // Unified items for "All" tab
  const unifiedItems: UnifiedDocumentItem[] = [
    ...records.map((r) => ({
      type: 'record' as const,
      id: `record-${r.id}`,
      title: r.filename,
      subtitle: r.credentialType
        ? CREDENTIAL_TYPE_LABELS[r.credentialType as keyof typeof CREDENTIAL_TYPE_LABELS] ?? r.credentialType
        : null,
      status: r.status,
      date: r.createdAt,
      action: () => navigate(recordDetailPath(r.id)),
    })),
    ...credentials.map((c) => ({
      type: 'credential' as const,
      id: `cred-${c.recipientId}`,
      title: c.filename,
      subtitle: c.orgName ? `Issued by ${c.orgName}` : null,
      status: c.status,
      date: c.createdAt,
      action: () => navigate(verifyPath(c.publicId)),
    })),
    ...attestations.map((a) => ({
      type: 'attestation' as const,
      id: `att-${a.id}`,
      title: `${a.attestation_type} — ${a.subject_identifier}`,
      subtitle: `by ${a.attester_name}`,
      status: a.status,
      date: a.created_at,
      action: () => navigate(`/verify/attestation/${a.public_id}`),
    })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Filter helpers
  const filterBySearch = <T extends { title?: string; filename?: string; fingerprint?: string; subject_identifier?: string; attester_name?: string }>(item: T): boolean => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.trim().toLowerCase();
    const searchable = [
      (item as Record<string, unknown>).title,
      (item as Record<string, unknown>).filename,
      (item as Record<string, unknown>).fingerprint,
      (item as Record<string, unknown>).subject_identifier,
      (item as Record<string, unknown>).attester_name,
    ].filter(Boolean).map(String).join(' ').toLowerCase();
    return searchable.includes(q);
  };

  const filterByStatus = (status: string): boolean => {
    if (statusFilter === 'ALL') return true;
    return status === statusFilter;
  };

  // Loading state
  const isLoading = recordsLoading || credentialsLoading || attestationsLoading;

  // Counts for tab badges
  const recordCount = records.length;
  const credentialCount = credentials.length;
  const attestationCount = attestations.length;
  const totalCount = recordCount + credentialCount + attestationCount;

  return (
    <AppShell user={user} profile={profile} profileLoading={profileLoading} onSignOut={handleSignOut}>
      {/* Page header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{DOCUMENTS_PAGE_LABELS.PAGE_TITLE}</h1>
          <p className="text-muted-foreground mt-1">{DOCUMENTS_PAGE_LABELS.PAGE_SUBTITLE}</p>
        </div>
        <Button onClick={() => setSecureDialogOpen(true)} className="shrink-0 self-start sm:self-auto">
          <Plus className="mr-2 h-4 w-4" />
          {DOCUMENTS_PAGE_LABELS.SECURE_DOCUMENT}
        </Button>
      </div>

      {/* Revoke error */}
      {revokeError && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription className="flex items-center justify-between">
            <span>{revokeError}</span>
            <Button variant="ghost" size="sm" onClick={clearRevokeError}>Dismiss</Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as DocumentTab)} className="mb-4">
        <TabsList>
          <TabsTrigger value="all" className="gap-1.5">
            {DOCUMENTS_PAGE_LABELS.TAB_ALL}
            {!isLoading && <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0">{totalCount}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="records" className="gap-1.5">
            <FileText className="h-3.5 w-3.5" />
            {DOCUMENTS_PAGE_LABELS.TAB_RECORDS}
            {!isLoading && recordCount > 0 && <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0">{recordCount}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="credentials" className="gap-1.5">
            <Inbox className="h-3.5 w-3.5" />
            {DOCUMENTS_PAGE_LABELS.TAB_CREDENTIALS}
            {!isLoading && credentialCount > 0 && <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0">{credentialCount}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="attestations" className="gap-1.5">
            <Shield className="h-3.5 w-3.5" />
            {DOCUMENTS_PAGE_LABELS.TAB_ATTESTATIONS}
            {!isLoading && attestationCount > 0 && <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0">{attestationCount}</Badge>}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-1 gap-2">
              <div className="relative flex-1 max-w-sm">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search documents..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
                <SelectTrigger className="w-[160px]">
                  <Filter className="mr-2 h-4 w-4" />
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All Status</SelectItem>
                  <SelectItem value="PENDING">Pending</SelectItem>
                  <SelectItem value="SECURED">Secured</SelectItem>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  <SelectItem value="REVOKED">Revoked</SelectItem>
                  <SelectItem value="EXPIRED">Expired</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <Separator />
        <CardContent className="pt-0">
          {isLoading ? (
            <LoadingSkeleton />
          ) : activeTab === 'all' ? (
            <AllDocumentsList
              items={unifiedItems.filter(i => filterBySearch(i) && filterByStatus(i.status))}
            />
          ) : activeTab === 'records' ? (
            <RecordsList
              records={records.filter(r => filterBySearch(r) && filterByStatus(r.status))}
              allEmpty={records.length === 0}
              navigate={navigate}
              onSecure={() => setSecureDialogOpen(true)}
              onRevoke={handleRevokeRecord}
            />
          ) : activeTab === 'credentials' ? (
            <CredentialsList
              credentials={credentials.filter(c => filterBySearch(c) && filterByStatus(c.status))}
              allEmpty={credentials.length === 0}
              navigate={navigate}
            />
          ) : (
            <AttestationsList
              attestations={attestations.filter(a => filterBySearch(a) && filterByStatus(a.status))}
              allEmpty={attestations.length === 0}
              navigate={navigate}
            />
          )}
        </CardContent>
      </Card>

      {/* Secure Document Dialog */}
      <SecureDocumentDialog
        open={secureDialogOpen}
        onOpenChange={setSecureDialogOpen}
        onSuccess={handleSecureSuccess}
      />
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function LoadingSkeleton() {
  return (
    <div className="divide-y">
      {Array.from({ length: 5 }).map((_, idx) => (
        <div key={`skeleton-${idx}`} className="flex items-center gap-4 py-4 px-2">
          <Skeleton className="h-10 w-10 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-32" />
          </div>
          <Skeleton className="h-8 w-8" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted mb-4">
        <FileText className="h-7 w-7 text-muted-foreground" />
      </div>
      <h3 className="text-lg font-semibold mb-1">{title}</h3>
      <p className="text-sm text-muted-foreground max-w-sm">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const config = statusConfig[status] ?? { label: status, variant: 'secondary' as const, icon: Clock };
  const Icon = config.icon;
  return (
    <Badge variant={config.variant} className="shrink-0">
      <Icon className={`mr-1 h-3 w-3 ${status === 'SUBMITTED' ? 'animate-spin' : ''}`} />
      {config.label}
    </Badge>
  );
}

function TypeIcon({ type }: { type: 'record' | 'credential' | 'attestation' }) {
  if (type === 'credential') return <Award className="h-5 w-5 text-primary" />;
  if (type === 'attestation') return <Shield className="h-5 w-5 text-primary" />;
  return <FileText className="h-5 w-5 text-muted-foreground" />;
}

function TypeBadge({ type }: { type: 'record' | 'credential' | 'attestation' }) {
  const labels = { record: 'Record', credential: 'Credential', attestation: 'Attestation' };
  const variants = { record: 'outline' as const, credential: 'default' as const, attestation: 'secondary' as const };
  return <Badge variant={variants[type]} className="text-[10px] px-1.5 py-0">{labels[type]}</Badge>;
}

// "All" tab — unified list sorted by date
function AllDocumentsList({
  items,
}: {
  items: UnifiedDocumentItem[];
}) {
  if (items.length === 0) {
    return <EmptyState title={DOCUMENTS_PAGE_LABELS.EMPTY_TITLE} description="No documents match your search." />;
  }

  return (
    <div className="divide-y">
      {items.map((item) => (
        <div
          key={item.id}
          role="button"
          tabIndex={0}
          className="flex items-center gap-4 py-4 px-2 hover:bg-muted/50 transition-colors cursor-pointer"
          onClick={item.action}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.action(); } }}
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted shrink-0">
            <TypeIcon type={item.type} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <p className="text-sm font-medium truncate">{item.title}</p>
              <TypeBadge type={item.type} />
              <StatusBadge status={item.status} />
            </div>
            {item.subtitle && (
              <p className="text-xs text-muted-foreground truncate">{item.subtitle}</p>
            )}
          </div>
          <div className="text-right hidden sm:block shrink-0">
            <p className="text-sm text-muted-foreground">{formatDate(item.date)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// "My Records" tab — same as the old MyRecordsPage list
function RecordsList({
  records,
  allEmpty,
  navigate,
  onSecure,
  onRevoke,
}: {
  records: AnchorRecord[];
  allEmpty: boolean;
  navigate: ReturnType<typeof useNavigate>;
  onSecure: () => void;
  onRevoke: (r: AnchorRecord) => void;
}) {
  if (records.length === 0) {
    return (
      <EmptyState
        title={allEmpty ? 'No records yet' : 'No matching records'}
        description={allEmpty ? 'Secure your first document to create a permanent, tamper-proof record.' : 'Try adjusting your search or filter criteria.'}
        action={allEmpty ? (
          <Button onClick={onSecure}>
            <Plus className="mr-2 h-4 w-4" />
            Secure Document
          </Button>
        ) : undefined}
      />
    );
  }

  return (
    <div className="divide-y">
      {records.map((record) => (
          <div
            key={record.id}
            role="button"
            tabIndex={0}
            className="flex items-center gap-4 py-4 px-2 hover:bg-muted/50 transition-colors cursor-pointer"
            onClick={() => navigate(recordDetailPath(record.id))}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(recordDetailPath(record.id)); } }}
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted shrink-0">
              <FileText className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <p className="text-sm font-medium truncate">{record.filename}</p>
                <StatusBadge status={record.status} />
              </div>
              <div className="flex items-center gap-2">
                <p className="text-xs text-muted-foreground font-mono truncate">
                  {record.fingerprint.slice(0, 16)}...{record.fingerprint.slice(-8)}
                </p>
                {record.credentialType && (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <GraduationCap className="h-3 w-3" />
                    {CREDENTIAL_TYPE_LABELS[record.credentialType as keyof typeof CREDENTIAL_TYPE_LABELS] ?? record.credentialType}
                  </span>
                )}
              </div>
            </div>
            <div className="text-right hidden sm:block shrink-0">
              <p className="text-sm text-muted-foreground">{formatDate(record.createdAt)}</p>
              <p className="text-xs text-muted-foreground">{formatFileSize(record.fileSize)}</p>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="shrink-0" onClick={(e) => e.stopPropagation()}>
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="sr-only">Actions</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => navigate(recordDetailPath(record.id))}>
                  <Eye className="mr-2 h-4 w-4" />
                  View Record
                </DropdownMenuItem>
                {record.status === 'SECURED' && (
                  <DropdownMenuItem>
                    <Download className="mr-2 h-4 w-4" />
                    Download Proof
                  </DropdownMenuItem>
                )}
                {record.status !== 'REVOKED' && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={(e) => { e.stopPropagation(); onRevoke(record); }}
                      className="text-destructive focus:text-destructive"
                    >
                      <XCircle className="mr-2 h-4 w-4" />
                      Revoke Record
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
    </div>
  );
}

// "Issued to Me" tab — credentials received from organizations
function CredentialsList({
  credentials,
  allEmpty,
  navigate,
}: {
  credentials: ReceivedCredential[];
  allEmpty: boolean;
  navigate: ReturnType<typeof useNavigate>;
}) {
  if (credentials.length === 0) {
    return (
      <EmptyState
        title={allEmpty ? 'No credentials yet' : 'No matching credentials'}
        description={allEmpty ? 'When organizations issue credentials to your email address, they will appear here.' : 'Try adjusting your search or filter criteria.'}
      />
    );
  }

  return (
    <div className="divide-y">
      {credentials.map((cred) => {
        const typeLabel = cred.credentialType
          ? CREDENTIAL_TYPE_LABELS[cred.credentialType as keyof typeof CREDENTIAL_TYPE_LABELS] ?? cred.credentialType
          : null;

        return (
          <div
            key={cred.recipientId}
            role="button"
            tabIndex={0}
            className="flex items-center gap-4 py-4 px-2 hover:bg-muted/50 transition-colors cursor-pointer"
            onClick={() => navigate(verifyPath(cred.publicId))}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(verifyPath(cred.publicId)); } }}
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-primary/15 to-primary/5 shrink-0">
              <Award className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <p className="text-sm font-medium truncate">{cred.filename}</p>
                <StatusBadge status={cred.status} />
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {typeLabel && <span>{typeLabel}</span>}
                {cred.orgName && (
                  <span className="flex items-center gap-1">
                    <Building2 className="h-3 w-3" />
                    {cred.orgName}
                  </span>
                )}
              </div>
            </div>
            <div className="text-right hidden sm:block shrink-0">
              <p className="text-sm text-muted-foreground">{formatDate(cred.createdAt)}</p>
            </div>
            <Button variant="ghost" size="sm" className="shrink-0 h-7 px-2 text-xs" onClick={(e) => { e.stopPropagation(); navigate(verifyPath(cred.publicId)); }}>
              <ExternalLink className="mr-1 h-3 w-3" />
              Verify
            </Button>
          </div>
        );
      })}
    </div>
  );
}

// "Attestations" tab
function AttestationsList({
  attestations,
  allEmpty,
  navigate,
}: {
  attestations: Attestation[];
  allEmpty: boolean;
  navigate: ReturnType<typeof useNavigate>;
}) {
  if (attestations.length === 0) {
    return (
      <EmptyState
        title={allEmpty ? 'No attestations yet' : 'No matching attestations'}
        description={allEmpty ? 'Create an attestation to verify, endorse, or audit a credential.' : 'Try adjusting your search or filter criteria.'}
        action={allEmpty ? (
          <Button onClick={() => navigate(ROUTES.ATTESTATIONS)}>
            <Plus className="mr-2 h-4 w-4" />
            Create Attestation
          </Button>
        ) : undefined}
      />
    );
  }

  return (
    <div className="divide-y">
      {attestations.map((att) => (
        <div
          key={att.id}
          role="button"
          tabIndex={0}
          className="flex items-center gap-4 py-4 px-2 hover:bg-muted/50 transition-colors cursor-pointer"
          onClick={() => navigate(`/verify/attestation/${att.public_id}`)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/verify/attestation/${att.public_id}`); } }}
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted shrink-0">
            <Shield className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <p className="text-sm font-medium truncate">{att.attestation_type} — {att.subject_identifier}</p>
              <StatusBadge status={att.status} />
            </div>
            <p className="text-xs text-muted-foreground truncate">by {att.attester_name}</p>
          </div>
          <div className="text-right hidden sm:block shrink-0">
            <p className="text-sm text-muted-foreground">{formatDate(att.created_at)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
