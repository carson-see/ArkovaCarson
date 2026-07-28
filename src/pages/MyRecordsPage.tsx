/**
 * My Records Page
 *
 * Full records list with search and status filtering.
 * Separate from Dashboard which shows an overview.
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
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
  FolderInput,
  FolderX,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useAnchors } from '@/hooks/useAnchors';
import { useRevokeAnchor } from '@/hooks/useRevokeAnchor';
import { useFolders, type Folder } from '@/hooks/useFolders';
import { AppShell } from '@/components/layout';
import { SecureDocumentDialog } from '@/components/anchor';
import {
  FolderSidebar,
  FolderFormDialog,
  DeleteFolderDialog,
  MoveToFolderDialog,
  type FolderSelection,
} from '@/components/folders';
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
import { CREDENTIAL_TYPE_LABELS, FOLDER_LABELS } from '@/lib/copy';
import { formatDate, formatFileSize } from '@/lib/formatters';
import type { Record } from '@/components/records';

/** Local discriminated state for the shared create/rename folder dialog. */
type FolderDialogState = { mode: 'create' } | { mode: 'rename'; folder: Folder };

const statusConfig = {
  PENDING: { label: 'Pending', variant: 'warning' as const, icon: Clock },
  BROADCASTING: { label: 'Pending', variant: 'warning' as const, icon: Clock },
  SUBMITTED: { label: 'Awaiting Confirmation', variant: 'secondary' as const, icon: Loader2 },
  SECURED: { label: 'Secured', variant: 'success' as const, icon: CheckCircle },
  REVOKED: { label: 'Revoked', variant: 'secondary' as const, icon: XCircle },
  EXPIRED: { label: 'Expired', variant: 'secondary' as const, icon: AlertTriangle },
  SUPERSEDED: { label: 'Superseded', variant: 'outline' as const, icon: CheckCircle },
  PENDING_RESOLUTION: { label: 'Needs Review', variant: 'warning' as const, icon: Clock },
};

type StatusFilter = 'ALL' | 'PENDING' | 'SUBMITTED' | 'SECURED' | 'REVOKED' | 'EXPIRED';

export function MyRecordsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const { records, loading: recordsLoading, refreshAnchors } = useAnchors();
  const { revokeAnchor, error: revokeError, clearError: clearRevokeError } = useRevokeAnchor();
  const { folders, loading: foldersLoading, createFolder, renameFolder, deleteFolder, assignRecord } = useFolders();

  // NCA-FU2 (SCRUM-906) — deep-linked from the compliance scorecard with
  // `?action=upload&credential_type=...`. URL params are scrubbed post-mount
  // so a page refresh doesn't re-open the dialog.
  const initialCredentialType = searchParams.get('credential_type') ?? undefined;
  const initialJurisdiction = searchParams.get('jurisdiction') ?? undefined;
  const shouldAutoOpenUpload = searchParams.get('action') === 'upload';
  const [secureDialogOpen, setSecureDialogOpen] = useState(shouldAutoOpenUpload);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');

  // SCRUM-2940: folder sidebar/filter state + create/rename/delete/move dialogs.
  const [folderFilter, setFolderFilter] = useState<FolderSelection>('ALL');
  const [folderDialog, setFolderDialog] = useState<FolderDialogState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Folder | null>(null);
  const [moveTarget, setMoveTarget] = useState<Record | null>(null);

  useEffect(() => {
    if (shouldAutoOpenUpload) {
      const next = new URLSearchParams(searchParams);
      next.delete('action');
      next.delete('credential_type');
      next.delete('jurisdiction');
      setSearchParams(next, { replace: true });
    }
    // Only run once on mount; we intentionally want the initial URL state, not
    // re-fires if the user later adds these params via navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // SCRUM-2940 — folder create/rename share one dialog; onSubmit rethrows on
  // failure so FolderFormDialog can show the inline duplicate-name/generic
  // error and keep itself open. Only a resolved submit reaches the toast.
  const handleFolderSubmit = useCallback(async (name: string) => {
    if (!folderDialog) return;
    if (folderDialog.mode === 'create') {
      await createFolder(name);
      toast.success(FOLDER_LABELS.TOAST_CREATED);
    } else {
      await renameFolder(folderDialog.folder.id, name);
      toast.success(FOLDER_LABELS.TOAST_RENAMED);
    }
  }, [folderDialog, createFolder, renameFolder]);

  const handleDeleteFolderConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await deleteFolder(deleteTarget.id);
      toast.success(FOLDER_LABELS.TOAST_DELETED);
      // Records fall back to Unfiled (ON DELETE SET NULL) — if we were
      // viewing the folder being deleted, fall back to All Records so the
      // view doesn't silently go empty.
      setFolderFilter((prev) => (prev === deleteTarget.id ? 'ALL' : prev));
    } catch {
      toast.error(FOLDER_LABELS.ERR_DELETE);
    }
  }, [deleteFolder, deleteTarget]);

  const handleMoveSelect = useCallback(async (folderId: string | null) => {
    if (!moveTarget) return;
    try {
      await assignRecord(moveTarget.id, folderId);
      toast.success(folderId === null ? FOLDER_LABELS.TOAST_UNFILED : FOLDER_LABELS.TOAST_ASSIGNED);
    } catch {
      toast.error(FOLDER_LABELS.ERR_ASSIGN);
    }
  }, [assignRecord, moveTarget]);

  const handleRemoveFromFolder = useCallback(async (record: Record) => {
    try {
      await assignRecord(record.id, null);
      toast.success(FOLDER_LABELS.TOAST_UNFILED);
    } catch {
      toast.error(FOLDER_LABELS.ERR_ASSIGN);
    }
  }, [assignRecord]);

  // Filter records by folder, then search query and status.
  const filteredRecords = useMemo(() => records.filter((r) => {
    if (folderFilter === 'UNFILED' && r.folderId) return false;
    if (folderFilter !== 'ALL' && folderFilter !== 'UNFILED' && r.folderId !== folderFilter) return false;
    if (statusFilter !== 'ALL' && r.status !== statusFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      return r.filename.toLowerCase().includes(q) || r.fingerprint.toLowerCase().includes(q);
    }
    return true;
  }), [records, folderFilter, statusFilter, searchQuery]);

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

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        {/* Folder sidebar/filter (SCRUM-2940) */}
        <aside className="lg:w-60 shrink-0">
          <FolderSidebar
            folders={folders}
            loading={foldersLoading}
            selected={folderFilter}
            onSelect={setFolderFilter}
            onNewFolder={() => setFolderDialog({ mode: 'create' })}
            onRename={(folder) => setFolderDialog({ mode: 'rename', folder })}
            onDelete={(folder) => setDeleteTarget(folder)}
          />
        </aside>

        <div className="flex-1 min-w-0">
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
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            setMoveTarget(record);
                          }}
                        >
                          <FolderInput className="mr-2 h-4 w-4" />
                          {FOLDER_LABELS.ASSIGN_TRIGGER}
                        </DropdownMenuItem>
                        {record.folderId && (
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRemoveFromFolder(record);
                            }}
                          >
                            <FolderX className="mr-2 h-4 w-4" />
                            {FOLDER_LABELS.REMOVE_FROM_FOLDER}
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
        </div>
      </div>

      {/* Secure Document Dialog */}
      <SecureDocumentDialog
        open={secureDialogOpen}
        onOpenChange={setSecureDialogOpen}
        onSuccess={handleSecureSuccess}
        initialCredentialType={initialCredentialType}
        initialJurisdiction={initialJurisdiction}
      />

      {/* Folder dialogs (SCRUM-2940) */}
      <FolderFormDialog
        open={folderDialog !== null}
        onOpenChange={(open) => { if (!open) setFolderDialog(null); }}
        mode={folderDialog?.mode ?? 'create'}
        initialName={folderDialog?.mode === 'rename' ? folderDialog.folder.name : undefined}
        onSubmit={handleFolderSubmit}
      />
      <DeleteFolderDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        folderName={deleteTarget?.name ?? ''}
        onConfirm={handleDeleteFolderConfirm}
      />
      <MoveToFolderDialog
        open={moveTarget !== null}
        onOpenChange={(open) => { if (!open) setMoveTarget(null); }}
        folders={folders}
        currentFolderId={moveTarget?.folderId ?? null}
        onSelect={handleMoveSelect}
      />
    </AppShell>
  );
}
