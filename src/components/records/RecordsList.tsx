/**
 * Records List Component
 *
 * Refined list with hover transitions, status glows, and polished typography.
 */

import { FileText, CheckCircle, Clock, MoreHorizontal, Eye, Download, XCircle, AlertTriangle, GraduationCap } from 'lucide-react';
import { CREDENTIAL_TYPE_LABELS } from '@/lib/copy';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface Record {
  id: string;
  filename: string;
  fingerprint: string;
  status: 'PENDING' | 'SECURED' | 'REVOKED' | 'EXPIRED';
  createdAt: string;
  securedAt?: string;
  fileSize: number;
  credentialType?: string | null;
}

interface RecordsListProps {
  records: Record[];
  loading?: boolean;
  onViewRecord?: (record: Record) => void;
  onDownloadProof?: (record: Record) => void;
  onRevokeRecord?: (record: Record) => void;
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

export function RecordsList({
  records,
  loading,
  onViewRecord,
  onDownloadProof,
  onRevokeRecord,
}: Readonly<RecordsListProps>) {
  if (loading) {
    return (
      <div className="divide-y divide-border/60">
        {Array.from({ length: 3 }).map((_, idx) => (
          <RecordSkeleton key={`skeleton-${idx}`} />
        ))}
      </div>
    );
  }

  if (records.length === 0) {
    return null;
  }

  return (
    <div className="divide-y divide-border/60">
      {records.map((record) => (
        <RecordRow
          key={record.id}
          record={record}
          onView={() => onViewRecord?.(record)}
          onDownload={() => onDownloadProof?.(record)}
          onRevoke={() => onRevokeRecord?.(record)}
        />
      ))}
    </div>
  );
}

interface RecordRowProps {
  record: Record;
  onView: () => void;
  onDownload: () => void;
  onRevoke: () => void;
}

function RecordRow({ record, onView, onDownload, onRevoke }: Readonly<RecordRowProps>) {
  const status = statusConfig[record.status];
  const StatusIcon = status.icon;

  return (
    <div
      className="group flex items-center gap-4 py-4 px-3 -mx-1 rounded-lg hover:bg-muted/40 transition-all duration-200 cursor-pointer"
      onClick={onView}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onView(); }}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted/70 shrink-0 group-hover:bg-primary/8 transition-colors duration-200">
        <FileText className="h-5 w-5 text-muted-foreground group-hover:text-primary/70 transition-colors duration-200" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2.5 mb-1">
          <p className="text-sm font-semibold truncate group-hover:text-primary transition-colors duration-200">
            {record.filename}
          </p>
          <Badge variant={status.variant} className="shrink-0 text-[0.65rem] px-2 py-0.5">
            <StatusIcon className="mr-1 h-3 w-3" />
            {status.label}
          </Badge>
        </div>
        <div className="flex items-center gap-2.5">
          <p className="text-[0.7rem] text-muted-foreground font-mono truncate opacity-70">
            {record.fingerprint.slice(0, 16)}...{record.fingerprint.slice(-8)}
          </p>
          {record.credentialType && (
            <span className="inline-flex items-center gap-1 text-[0.7rem] text-muted-foreground">
              <GraduationCap className="h-3 w-3" />
              {CREDENTIAL_TYPE_LABELS[record.credentialType as keyof typeof CREDENTIAL_TYPE_LABELS] ?? record.credentialType}
            </span>
          )}
        </div>
      </div>

      <div className="text-right hidden sm:block shrink-0">
        <p className="text-xs font-medium text-muted-foreground">
          {formatDate(record.createdAt)}
        </p>
        <p className="text-[0.65rem] text-muted-foreground/60 mt-0.5">
          {formatFileSize(record.fileSize)}
        </p>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="h-4 w-4" />
            <span className="sr-only">Actions</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="animate-scale-in">
          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onView(); }}>
            <Eye className="mr-2 h-4 w-4" />
            View Record
          </DropdownMenuItem>
          {record.status === 'SECURED' && (
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onDownload(); }}>
              <Download className="mr-2 h-4 w-4" />
              Download Proof
            </DropdownMenuItem>
          )}
          {record.status !== 'REVOKED' && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={(e) => { e.stopPropagation(); onRevoke(); }}
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
}

function RecordSkeleton() {
  return (
    <div className="flex items-center gap-4 py-4 px-3">
      <div className="h-10 w-10 rounded-xl shimmer" />
      <div className="flex-1 space-y-2.5">
        <div className="h-4 w-48 rounded shimmer" />
        <div className="h-3 w-32 rounded shimmer" />
      </div>
      <div className="h-8 w-8 rounded shimmer" />
    </div>
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
