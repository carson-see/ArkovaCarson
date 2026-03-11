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
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Search,
  Filter,
  MoreHorizontal,
  Eye,
  Download,
  Loader2,
  FileDown,
  CalendarIcon,
  X,
} from 'lucide-react';
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
    variant: 'secondary' as const,
    icon: XCircle,
  },
  EXPIRED: {
    label: 'Expired',
    variant: 'secondary' as const,
    icon: AlertTriangle,
  },
};

const PAGE_SIZE = 10;

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
    if (searchQuery.trim()) {
      const q = searchQuery.trim();
      query = query.or(`filename.ilike.%${q}%,fingerprint.ilike.%${q}%`);
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
      setAnchors(data || []);
      setTotalCount(count || 0);
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

  const formatFileSize = (bytes: number | null): string => {
    if (!bytes) return '-';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

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

      {/* Table */}
      <div className="rounded-md border">
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
              <TableHead className="hidden md:table-cell">Fingerprint</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden sm:table-cell">Size</TableHead>
              <TableHead className="hidden lg:table-cell">Created</TableHead>
              <TableHead className="w-[60px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center">
                  <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : (anchors.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  No records found
                </TableCell>
              </TableRow>
            ) : (
              anchors.map((anchor) => {
                const status = statusConfig[anchor.status];
                const StatusIcon = status.icon;

                return (
                  <TableRow key={anchor.id} data-state={selectedIds.has(anchor.id) ? 'selected' : undefined}>
                    <TableCell>
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
                    <TableCell className="hidden md:table-cell">
                      <code className="text-xs text-muted-foreground">
                        {formatFingerprint(anchor.fingerprint, 8, 4)}
                      </code>
                    </TableCell>
                    <TableCell>
                      <Badge variant={status.variant}>
                        <StatusIcon className="mr-1 h-3 w-3" />
                        {status.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-muted-foreground">
                      {formatFileSize(anchor.file_size)}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-muted-foreground">
                      {formatDate(anchor.created_at)}
                    </TableCell>
                    <TableCell>
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
