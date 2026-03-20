/**
 * Records List Component
 *
 * Displays a list of secured documents with status and actions.
 */

import { FileText, CheckCircle, Clock, MoreHorizontal, Eye, Download, XCircle, AlertTriangle, GraduationCap, Loader2 } from 'lucide-react';
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
import { Skeleton } from '@/components/ui/skeleton';

export interface Record {
  id: string;
  filename: string;
  fingerprint: string;
  status: 'PENDING' | 'SUBMITTED' | 'SECURED' | 'REVOKED' | 'EXPIRED';
  createdAt: string;
  securedAt?: string;
  fileSize: number;
  credentialType?: string | null;
  /** Network receipt ID for explorer links (populated after SUBMITTED) */
  chainTxId?: string | null;
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
  SUBMITTED: {
    label: 'Awaiting Confirmation',
    variant: 'secondary' as const,
    icon: Loader2,
  },
  SECURED: {
    label: 'Secured',
    variant: 'success' as const,
    icon: CheckCircle,
  },
  REVOKED: {
    label: 'Revoked',
    variant: 'destructive' as const,
    icon: XCircle,
  },
  EXPIRED: {
    label: 'Expired',
    variant: 'outline' as const,
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
      <div className="divide-y">
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
    <div className="divide-y">
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
    <div className="flex items-center gap-4 py-4 px-2 hover:bg-muted/50 transition-colors">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted shrink-0">
        <FileText className="h-5 w-5 text-muted-foreground" />
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate mb-1">
          {record.filename}
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant={status.variant} className="shrink-0">
            <StatusIcon className="mr-1 h-3 w-3" />
            {status.label}
          </Badge>
          {record.credentialType && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground shrink-0">
              <GraduationCap className="h-3 w-3" />
              {CREDENTIAL_TYPE_LABELS[record.credentialType as keyof typeof CREDENTIAL_TYPE_LABELS] ?? record.credentialType}
            </span>
          )}
          <p className="text-xs text-muted-foreground font-mono truncate">
            {record.fingerprint.slice(0, 16)}...{record.fingerprint.slice(-8)}
          </p>
        </div>
      </div>

      <div className="text-right hidden sm:block shrink-0 ml-4">
        <p className="text-sm text-muted-foreground whitespace-nowrap">
          {formatDate(record.createdAt)}
        </p>
        <p className="text-xs text-muted-foreground">
          {formatFileSize(record.fileSize)}
        </p>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="shrink-0">
            <MoreHorizontal className="h-4 w-4" />
            <span className="sr-only">Actions</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onView}>
            <Eye className="mr-2 h-4 w-4" />
            View Record
          </DropdownMenuItem>
          {record.status === 'SECURED' && (
            <DropdownMenuItem onClick={onDownload}>
              <Download className="mr-2 h-4 w-4" />
              Download Proof
            </DropdownMenuItem>
          )}
          {record.status !== 'REVOKED' && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={onRevoke}
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
    <div className="flex items-center gap-4 py-4 px-2">
      <Skeleton className="h-10 w-10 rounded-lg" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-3 w-32" />
      </div>
      <Skeleton className="h-8 w-8" />
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
