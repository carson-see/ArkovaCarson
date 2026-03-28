/**
 * My Records Page
 *
 * Full records list with search and status filtering.
 * Separate from Dashboard which shows an overview.
 */

import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
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
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useAnchors } from '@/hooks/useAnchors';
import { useRevokeAnchor } from '@/hooks/useRevokeAnchor';
import { AppShell } from '@/components/layout';
import { SecureDocumentDialog } from '@/components/anchor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
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
import { ROUTES, recordDetailPath } from '@/lib/routes';
import { CREDENTIAL_TYPE_LABELS } from '@/lib/copy';
import type { Record } from '@/components/records';

const statusConfig = {
  PENDING: { label: 'Pending', variant: 'warning' as const, icon: Clock },
  BROADCASTING: { label: 'Pending', variant: 'warning' as const, icon: Clock },
  SUBMITTED: { label: 'Awaiting Confirmation', variant: 'secondary' as const, icon: Loader2 },
  SECURED: { label: 'Secured', variant: 'success' as const, icon: CheckCircle },
  REVOKED: { label: 'Revoked', variant: 'secondary' as const, icon: XCircle },
  EXPIRED: { label: 'Expired', variant: 'secondary' as const, icon: AlertTriangle },
};

type StatusFilter = 'ALL' | 'PENDING' | 'SUBMITTED' | 'SECURED' | 'REVOKED' | 'EXPIRED';

export function MyRecordsPage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const { records, loading: recordsLoading, refreshAnchors } = useAnchors();
  const { revokeAnchor, error: revokeError, clearError: clearRevokeError } = useRevokeAnchor();
  const [secureDialogOpen, setSecureDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  // Realtime subscription in useAnchors handles INSERT — no manual refresh needed
  const handleSecureSuccess = useCallback(() => {}, []);

  const handleRevokeRecord = useCallback(async (record: Record) => {
    const success = await revokeAnchor(record.id);
    if (success) {
      await refreshAnchors();
    }
  }, [revokeAnchor, refreshAnchors]);

  // Filter records by search query and status
  const filteredRecords = records.filter((r) => {
    if (statusFilter !== 'ALL' && r.status !== statusFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      return r.filename.toLowerCase().includes(q) || r.fingerprint.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <AppShell
      user={user}
      profile={profile}
      profileLoading={profileLoading}
      onSignOut={handleSignOut}
    >
      {/* Page header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My Records</h1>
          <p className="text-muted-foreground mt-1">
            Browse and manage all your secured documents
          </p>
        </div>
        <Button onClick={() => setSecureDialogOpen(true)} className="shrink-0 self-start sm:self-auto">
          <Plus className="mr-2 h-4 w-4" />
          Secure Document
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

      {/* Filters */}
      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-1 gap-2">
              <div className="relative flex-1 max-w-sm">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search by filename or fingerprint..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Select
                value={statusFilter}
                onValueChange={(value) => setStatusFilter(value as StatusFilter)}
              >
                <SelectTrigger className="w-[140px]">
                  <Filter className="mr-2 h-4 w-4" />
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All Status</SelectItem>
                  <SelectItem value="PENDING">Pending</SelectItem>
                  <SelectItem value="SECURED">Secured</SelectItem>
                  <SelectItem value="REVOKED">Revoked</SelectItem>
                  <SelectItem value="EXPIRED">Expired</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-sm text-muted-foreground">
              {filteredRecords.length} record{filteredRecords.length !== 1 ? 's' : ''}
            </p>
          </div>
        </CardHeader>
        <Separator />
        <CardContent className="pt-0">
          {recordsLoading ? (
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
          ) : (filteredRecords.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted mb-4">
                <FileText className="h-7 w-7 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-semibold mb-1">
                {records.length === 0 ? 'No records yet' : 'No matching records'}
              </h3>
              <p className="text-sm text-muted-foreground max-w-sm">
                {records.length === 0
                  ? 'Secure your first document to create a permanent, tamper-proof record.'
                  : 'Try adjusting your search or filter criteria.'}
              </p>
              {records.length === 0 && (
                <Button className="mt-4" onClick={() => setSecureDialogOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Secure Document
                </Button>
              )}
            </div>
          ) : (
            <div className="divide-y">
              {filteredRecords.map((record) => {
                const status = statusConfig[record.status];
                const StatusIcon = status.icon;

                return (
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
                        <Badge variant={status.variant} className="shrink-0">
                          <StatusIcon className="mr-1 h-3 w-3" />
                          {status.label}
                        </Badge>
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
                      <p className="text-sm text-muted-foreground">
                        {formatDate(record.createdAt)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatFileSize(record.fileSize)}
                      </p>
                    </div>

                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="shrink-0"
                          onClick={(e) => e.stopPropagation()}
                        >
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
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRevokeRecord(record);
                              }}
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
                );
              })}
            </div>
          ))}
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
