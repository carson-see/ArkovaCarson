/**
 * Organization Registry Table
 *
 * Server-side paginated table of org anchors with filtering.
 * Features: status filter, search (filename + fingerprint),
 * date range filter, bulk selection, CSV export.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  FileText,
  CheckCircle,
  Clock,
  XCircle,
  Ban,
  ChevronLeft,
  ChevronRight,
  Search,
  Filter,
  MoreHorizontal,
  Eye,
  Download,
  Copy,
  Loader2,
  FileDown,
  CalendarIcon,
  GraduationCap,
  X,
} from 'lucide-react';
import { CREDENTIAL_TYPE_LABELS, SHARE_LABELS, ORG_PAGE_LABELS } from '@/lib/copy';
import { verifyUrl } from '@/lib/routes';
import { toast } from 'sonner';
import { useExportAnchors } from '@/hooks/useExportAnchors';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/lib/supabase';
import { formatFingerprint } from '@/lib/fileHasher';
import type { Database } from '@/types/database.types';

type Anchor = Database['public']['Tables']['anchors']['Row'];
type AnchorStatus = Database['public']['Enums']['anchor_status'];

interface OrgRegistryTableProps {
  orgId: string;
  onViewAnchor?: (anchor: Anchor) => void;
  onRevokeAnchor?: (anchor: Anchor) => void;
  onDownloadProof?: (anchor: Anchor) => void;
}

const statusConfig = {
  PENDING: {
    label: 'Pending',
    variant: 'warning' as const,
    icon: Clock,
  },
  SECURED: {
    label: 'Secured',
    variant: 'success' as const,
    icon: CheckCircle,
  },
  REVOKED: {
    label: 'Revoked',
    variant: 'destructive' as const,
    icon: Ban,
  },
  EXPIRED: {
    label: 'Expired',
    variant: 'outline' as const,
    icon: Clock,
  },
  SUBMITTED: {
    label: 'Submitted',
    variant: 'secondary' as const,
    icon: Loader2,
  },
};

const PAGE_SIZE = 10;

/** Extract recipient display name from anchor metadata or label */
function getRecipientDisplay(anchor: Anchor): string | null {
  const meta = anchor.metadata as Record<string, unknown> | null;
  if (!meta) return anchor.label || null;
  // Common metadata field names for recipient
  const recipientFields = ['recipient_name', 'recipientName', 'student_name', 'studentName', 'name', 'recipient'];
  for (const field of recipientFields) {
    if (meta[field] && typeof meta[field] === 'string') {
      return meta[field] as string;
    }
  }
  return anchor.label || null;
}

export function OrgRegistryTable({
  orgId,
  onViewAnchor,
  onRevokeAnchor,
  onDownloadProof,
}: Readonly<OrgRegistryTableProps>) {
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalCount, setTotalCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<AnchorStatus | 'ALL'>('ALL');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const { exportAnchors, loading: exporting } = useExportAnchors();

  const handleExport = useCallback(async () => {
    await exportAnchors(orgId);
  }, [exportAnchors, orgId]);

  const fetchAnchors = useCallback(async () => {
    setLoading(true);

    let query = supabase
      .from('anchors')
      .select('*', { count: 'exact' })
      .eq('org_id', orgId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE - 1);

    // Apply status filter
    if (statusFilter !== 'ALL') {
      query = query.eq('status', statusFilter);
    }

    // Apply search filter (filename OR fingerprint)
    // SEC-NEW-08: Sanitize input to prevent PostgREST filter injection
    if (searchQuery.trim()) {
      // Escape PostgREST ilike wildcards (% _) but preserve filename chars (. , _ → escaped)
      const q = searchQuery.trim().replace(/[%\\]/g, '');
      if (q.length > 0) {
        query = query.or(`filename.ilike.%${q}%,fingerprint.ilike.%${q}%`);
      }
    }

    // Apply date range filter
    if (dateFrom) {
      query = query.gte('created_at', `${dateFrom}T00:00:00Z`);
    }
    if (dateTo) {
      query = query.lte('created_at', `${dateTo}T23:59:59Z`);
    }

    const { data, error, count } = await query;

    if (error) {
      console.error('Error fetching anchors:', error);
    } else {
      // Exclude pipeline-generated anchors (pipeline_source in metadata)
      const userAnchors = (data || []).filter((a) => {
        const meta = a.metadata as { pipeline_source?: string } | null;
        return !meta?.pipeline_source;
      });
      setAnchors(userAnchors);
      setTotalCount(userAnchors.length < PAGE_SIZE ? userAnchors.length + (currentPage - 1) * PAGE_SIZE : (count || 0));
    }

    setLoading(false);
  }, [orgId, currentPage, statusFilter, searchQuery, dateFrom, dateTo]);

  useEffect(() => {
    fetchAnchors();
  }, [fetchAnchors]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
    setSelectedIds(new Set());
  }, [statusFilter, searchQuery, dateFrom, dateTo]);

  // Bulk selection handlers
  const allOnPageSelected = anchors.length > 0 && anchors.every((a) => selectedIds.has(a.id));

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        anchors.forEach((a) => next.delete(a.id));
      } else {
        anchors.forEach((a) => next.add(a.id));
      }
      return next;
    });
  }, [anchors, allOnPageSelected]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const handleBulkRevoke = useCallback(() => {
    const selected = anchors.filter((a) => selectedIds.has(a.id) && a.status !== 'REVOKED');
    if (selected.length > 0 && onRevokeAnchor) {
      selected.forEach((a) => onRevokeAnchor(a));
    }
  }, [anchors, selectedIds, onRevokeAnchor]);

  const clearDateRange = useCallback(() => {
    setDateFrom('');
    setDateTo('');
  }, []);

  const revocableSelected = anchors.filter(
    (a) => selectedIds.has(a.id) && a.status !== 'REVOKED'
  ).length;

  const formatDate = (dateString: string): string => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 gap-2">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
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
            onValueChange={(value) => setStatusFilter(value as AnchorStatus | 'ALL')}
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
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-4">
          <p className="text-sm text-muted-foreground">
            {totalCount} record{totalCount !== 1 ? 's' : ''} found
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={exporting || totalCount === 0}
          >
            {exporting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <FileDown className="mr-2 h-4 w-4" />
            )}
            Export CSV
          </Button>
        </div>
      </div>

      {/* Date Range Filter */}
      <div className="flex items-center gap-2 flex-wrap">
        <CalendarIcon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Date range:</span>
        <Input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="w-[160px] h-9"
        />
        <span className="text-sm text-muted-foreground">to</span>
        <Input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="w-[160px] h-9"
        />
        {(dateFrom || dateTo) && (
          <Button variant="ghost" size="sm" onClick={clearDateRange} className="h-9 px-2">
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Bulk Action Bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-md border bg-muted/50 px-4 py-2">
          <span className="text-sm font-medium">
            {selectedIds.size} selected
          </span>
          {revocableSelected > 0 && onRevokeAnchor && (
            <Button
              variant="destructive"
              size="sm"
              onClick={handleBulkRevoke}
            >
              <XCircle className="mr-2 h-4 w-4" />
              Revoke ({revocableSelected})
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={clearSelection}>
            Clear
          </Button>
        </div>
      )}

      {/* Mobile Card Layout (<640px) */}
      <div className="sm:hidden space-y-3">
        {loading ? (
          Array.from({ length: 3 }).map((_, idx) => (
            <div key={`mobile-skeleton-${idx}`} className="rounded-lg border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-6 w-16 rounded-full" />
              </div>
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-20" />
            </div>
          ))
        ) : anchors.length === 0 ? (
          <div className="rounded-lg border p-8 text-center text-muted-foreground">
            No records found
          </div>
        ) : (
          anchors.map((anchor) => {
            const status = statusConfig[anchor.status];
            const StatusIcon = status.icon;
            return (
              <div
                key={anchor.id}
                className="rounded-lg border bg-card p-4 shadow-card-rest hover:shadow-card-hover transition-all cursor-pointer"
                onClick={() => onViewAnchor?.(anchor)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate text-sm">
                      {anchor.filename}
                    </p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <Badge
                        variant={status.variant}
                        className={`text-xs ${anchor.status === 'PENDING' ? 'animate-pulse border-amber-400 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400' : ''} ${anchor.status === 'EXPIRED' ? 'border-amber-400 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400' : ''} ${anchor.status === 'REVOKED' ? 'border-red-400 bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400' : ''}`}
                      >
                        <StatusIcon className="mr-1 h-3 w-3" />
                        {status.label}
                      </Badge>
                      {anchor.credential_type && (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <GraduationCap className="h-3 w-3" />
                          {CREDENTIAL_TYPE_LABELS[anchor.credential_type as keyof typeof CREDENTIAL_TYPE_LABELS] ?? anchor.credential_type}
                        </span>
                      )}
                    </div>
                  </div>
                  <div onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                          <MoreHorizontal className="h-4 w-4" />
                          <span className="sr-only">Actions</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => onViewAnchor?.(anchor)}>
                          <Eye className="mr-2 h-4 w-4" />
                          View Details
                        </DropdownMenuItem>
                        {anchor.public_id && (
                          <DropdownMenuItem
                            onClick={async () => {
                              const url = verifyUrl(anchor.public_id!);
                              await navigator.clipboard.writeText(url);
                              toast.success(SHARE_LABELS.COPIED_TOAST);
                            }}
                          >
                            <Copy className="mr-2 h-4 w-4" />
                            {SHARE_LABELS.COPY_LINK}
                          </DropdownMenuItem>
                        )}
                        {anchor.status === 'SECURED' && (
                          <DropdownMenuItem onClick={() => onDownloadProof?.(anchor)}>
                            <Download className="mr-2 h-4 w-4" />
                            Download Proof
                          </DropdownMenuItem>
                        )}
                        {anchor.status !== 'REVOKED' && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() => onRevokeAnchor?.(anchor)}
                            >
                              <XCircle className="mr-2 h-4 w-4" />
                              Revoke
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
                <div className="flex items-center justify-between mt-2">
                  <p className="text-xs text-muted-foreground">
                    {formatDate(anchor.created_at)}
                  </p>
                  {getRecipientDisplay(anchor) && (
                    <p className="text-xs text-muted-foreground truncate max-w-[140px]">
                      {getRecipientDisplay(anchor)}
                    </p>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Desktop Table Layout (>=640px) */}
      <div className="hidden sm:block rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[40px]">
                <Checkbox
                  checked={allOnPageSelected && anchors.length > 0}
                  onCheckedChange={toggleSelectAll}
                  aria-label="Select all on page"
                />
              </TableHead>
              <TableHead>Document</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="hidden md:table-cell">Type</TableHead>
              <TableHead className="hidden md:table-cell">{ORG_PAGE_LABELS.RECIPIENT}</TableHead>
              <TableHead className="hidden lg:table-cell">Fingerprint</TableHead>
              <TableHead className="w-[60px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 5 }).map((_, idx) => (
                <TableRow key={`skeleton-${idx}`}>
                  <TableCell><Skeleton className="h-4 w-4" /></TableCell>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Skeleton className="h-8 w-8 rounded-lg" />
                      <Skeleton className="h-4 w-32" />
                    </div>
                  </TableCell>
                  <TableCell><Skeleton className="h-6 w-16 rounded-full" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell className="hidden md:table-cell"><Skeleton className="h-4 w-12" /></TableCell>
                  <TableCell className="hidden lg:table-cell"><Skeleton className="h-4 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-8 w-8" /></TableCell>
                </TableRow>
              ))
            ) : (anchors.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                  No records found
                </TableCell>
              </TableRow>
            ) : (
              anchors.map((anchor) => {
                const status = statusConfig[anchor.status];
                const StatusIcon = status.icon;

                return (
                  <TableRow
                    key={anchor.id}
                    data-state={selectedIds.has(anchor.id) ? 'selected' : undefined}
                    className="cursor-pointer"
                    onClick={() => onViewAnchor?.(anchor)}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedIds.has(anchor.id)}
                        onCheckedChange={() => toggleSelect(anchor.id)}
                        aria-label={`Select ${anchor.filename}`}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted shrink-0">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <span className="font-medium truncate max-w-[200px]">
                          {anchor.filename}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={status.variant}
                        className={`${anchor.status === 'PENDING' ? 'animate-pulse border-amber-400 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400' : ''} ${anchor.status === 'EXPIRED' ? 'border-amber-400 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400' : ''} ${anchor.status === 'REVOKED' ? 'border-red-400 bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400' : ''}`}
                      >
                        <StatusIcon className="mr-1 h-3 w-3" />
                        {status.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(anchor.created_at)}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {anchor.credential_type ? (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <GraduationCap className="h-3 w-3" />
                          {CREDENTIAL_TYPE_LABELS[anchor.credential_type as keyof typeof CREDENTIAL_TYPE_LABELS] ?? anchor.credential_type}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {getRecipientDisplay(anchor) ? (
                        <span className="text-xs text-muted-foreground truncate max-w-[140px] block">
                          {getRecipientDisplay(anchor)}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <code className="text-xs text-muted-foreground">
                        {formatFingerprint(anchor.fingerprint, 8, 4)}
                      </code>
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreHorizontal className="h-4 w-4" />
                            <span className="sr-only">Actions</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => onViewAnchor?.(anchor)}>
                            <Eye className="mr-2 h-4 w-4" />
                            View Details
                          </DropdownMenuItem>
                          {anchor.public_id && (
                            <DropdownMenuItem
                              onClick={async () => {
                                const url = verifyUrl(anchor.public_id!);
                                await navigator.clipboard.writeText(url);
                                toast.success(SHARE_LABELS.COPIED_TOAST);
                              }}
                            >
                              <Copy className="mr-2 h-4 w-4" />
                              {SHARE_LABELS.COPY_LINK}
                            </DropdownMenuItem>
                          )}
                          {anchor.status === 'SECURED' && (
                            <DropdownMenuItem onClick={() => onDownloadProof?.(anchor)}>
                              <Download className="mr-2 h-4 w-4" />
                              Download Proof
                            </DropdownMenuItem>
                          )}
                          {anchor.status !== 'REVOKED' && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => onRevokeAnchor?.(anchor)}
                              >
                                <XCircle className="mr-2 h-4 w-4" />
                                Revoke
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {currentPage} of {totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1 || loading}
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages || loading}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
