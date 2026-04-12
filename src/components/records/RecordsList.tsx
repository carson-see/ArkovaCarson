/**
 * Records List Component
 *
 * Displays a list of secured documents with status and actions.
 */

import { useState, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CheckCircle, Clock, MoreHorizontal, Eye, Download, XCircle, AlertTriangle, Loader2, RefreshCw, Mail, Copy, Check, ExternalLink } from 'lucide-react';
import { CREDENTIAL_TYPE_LABELS, REVOKED_EXPIRED_ACTIONS } from '@/lib/copy';
import { getExplorerBaseUrl } from '@/components/ui/ExplorerLink';
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
import { isSafeUrl } from '@/lib/urlValidator';

export interface Record {
  id: string;
  filename: string;
  fingerprint: string;
  status: 'PENDING' | 'BROADCASTING' | 'SUBMITTED' | 'SECURED' | 'REVOKED' | 'EXPIRED';
  createdAt: string;
  securedAt?: string;
  fileSize: number;
  credentialType?: string | null;
  /** Network receipt ID for explorer links (populated after SUBMITTED) */
  chainTxId?: string | null;
  /** Block height for display */
  chainBlockHeight?: number | null;
  /** Public ID for display */
  publicId?: string | null;
  /** Metadata for rich card rendering */
  metadata?: { [key: string]: unknown } | null;
  /** Issuer name extracted from metadata */
  issuerName?: string | null;
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
    label: 'Processing',
    tooltip: 'Your document is being anchored to the network',
    variant: 'warning' as const,
    icon: Clock,
  },
  BROADCASTING: {
    label: 'Processing',
    tooltip: 'Your document is being anchored to the network',
    variant: 'warning' as const,
    icon: Clock,
  },
  SUBMITTED: {
    label: 'Submitted',
    tooltip: 'Awaiting network confirmation — typically a few minutes',
    variant: 'secondary' as const,
    icon: Loader2,
  },
  SECURED: {
    label: 'Verified',
    tooltip: 'Permanently anchored and independently verifiable',
    variant: 'success' as const,
    icon: CheckCircle,
  },
  REVOKED: {
    label: 'Revoked',
    tooltip: 'This record has been revoked by the issuer',
    variant: 'destructive' as const,
    icon: XCircle,
  },
  EXPIRED: {
    label: 'Expired',
    tooltip: 'This record\'s validity period has ended',
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
      <div className="space-y-1 pt-4">
        {Array.from({ length: 3 }).map((_, idx) => (
          <RecordSkeleton key={`skeleton-${idx}`} />
        ))}
      </div>
    );
  }

  if (records.length === 0) {
    return null;
  }

  // Virtual scrolling: progressively render for large lists (Design Audit #20)
  const VIRTUAL_THRESHOLD = 100;
  if (records.length > VIRTUAL_THRESHOLD) {
    return (
      <VirtualizedRecordsList
        records={records}
        onViewRecord={onViewRecord}
        onDownloadProof={onDownloadProof}
        onRevokeRecord={onRevokeRecord}
      />
    );
  }

  return (
    <div className="space-y-1 pt-4">
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

/** True virtual scrolling for large lists (PERF-09) — only visible rows are in DOM */
function VirtualizedRecordsList({
  records,
  onViewRecord,
  onDownloadProof,
  onRevokeRecord,
}: Readonly<Omit<RecordsListProps, 'loading'>>) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: records.length,
    getScrollElement: () => parentRef.current,
    // Estimated row height — cards vary, virtualizer adjusts dynamically
    estimateSize: () => 220,
    overscan: 5,
  });

  return (
    <div
      ref={parentRef}
      className="pt-4 overflow-auto"
      style={{ maxHeight: 'calc(100vh - 200px)' }}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const record = records[virtualRow.index];
          return (
            <div
              key={record.id}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <RecordRow
                record={record}
                onView={() => onViewRecord?.(record)}
                onDownload={() => onDownloadProof?.(record)}
                onRevoke={() => onRevokeRecord?.(record)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface RecordRowProps {
  record: Record;
  onView: () => void;
  onDownload: () => void;
  onRevoke: () => void;
}

/** Inline copy button for card values */
function CardCopyButton({ value }: { value: string }) {
  const [justCopied, setJustCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center justify-center h-5 w-5 rounded text-[#859398] hover:text-[#00d4ff] transition-colors"
      onClick={async (e) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(value);
        setJustCopied(true);
        setTimeout(() => setJustCopied(false), 1500);
      }}
      aria-label="Copy"
    >
      {justCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

/** Format an ISO date string for display (e.g. "2026-04-01T00:00:00Z" → "April 1, 2026") */
function formatDateForDisplay(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

/**
 * Build a one-line description for a record card.
 * Priority: file_description → form_type + filing_date + period_of_report → issuer + issued_date
 */
function buildRecordDescription(record: Record): string | null {
  const meta = record.metadata;
  if (!meta) return null;

  // Explicit human-readable description from the source (e.g. EDGAR file_description)
  const fileDescription = meta.file_description as string | undefined;
  if (fileDescription) return fileDescription;

  const parts: string[] = [];

  // SEC/public-record style: form type + filing date + optional period
  const formType = meta.form_type as string | undefined;
  const filingDate = meta.filing_date as string | undefined;
  const periodOfReport = meta.period_of_report as string | undefined;

  if (formType) parts.push(formType);
  if (filingDate) parts.push(`Filed ${filingDate}`);
  if (periodOfReport && periodOfReport !== filingDate) parts.push(`Period ending ${periodOfReport}`);

  if (parts.length > 0) return parts.join(' · ');

  // User credential style: issuer + issued date
  const issuer = meta.issuer as string | undefined;
  const issuedDate = (meta.issued_date ?? meta.date) as string | undefined;

  if (issuer) parts.push(`Issued by ${issuer}`);
  if (issuedDate) parts.push(formatDateForDisplay(issuedDate));

  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Build a rich title from metadata like "Entity Name — Form Type (Date)" */
function buildRecordTitle(record: Record): string {
  const meta = record.metadata;
  if (!meta) return record.filename;

  const entityName = meta.entity_name ?? meta.issuer ?? meta.recipient_name ?? meta.recipient ?? meta.name;
  const formType = meta.form_type ?? meta.credential_type ?? meta.record_type;
  const date = meta.filing_date ?? meta.issued_date ?? meta.date;

  if (entityName && formType && date) {
    return `${entityName} — ${formType} (${formatDateForDisplay(date as string)})`;
  }
  if (entityName && formType) {
    return `${entityName} — ${formType}`;
  }
  if (entityName) {
    return String(entityName);
  }
  return record.filename;
}

/** Status colors matching Precision Engine design */
const STATUS_BADGE_CLASSES: { [key: string]: string } = {
  SECURED: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30',
  SUBMITTED: 'bg-amber-500/10 text-amber-400 border border-amber-500/30',
  PENDING: 'bg-amber-500/10 text-amber-400 border border-amber-500/30',
  REVOKED: 'bg-red-500/10 text-red-400 border border-red-500/30',
  EXPIRED: 'bg-[#859398]/10 text-[#859398] border border-[#859398]/30',
};

/** Internal keys filtered from metadata display (shown elsewhere in the card) */
const HIDDEN_META_KEYS = new Set([
  'pipeline_source', 'source_url', 'abstract', 'description', 'summary',
  'merkle_proof', 'merkle_root', 'merkle_index', 'batch_id',
  '_confidence', '_prompt_version', 'chain_tx_id', 'recipient', 'jurisdiction',
  // Shown in description line
  'file_description', 'form_type', 'filing_date', 'period_of_report',
  'entity_name', 'issuer', 'issued_date',
]);

function RecordRow({ record, onView, onDownload, onRevoke }: Readonly<RecordRowProps>) {
  const status = statusConfig[record.status];
  const StatusIcon = status.icon;
  const title = buildRecordTitle(record);
  const description = buildRecordDescription(record);
  const credentialLabel = record.credentialType
    ? CREDENTIAL_TYPE_LABELS[record.credentialType as keyof typeof CREDENTIAL_TYPE_LABELS] ?? record.credentialType
    : null;
  const meta = record.metadata;
  const sourceUrl = meta?.source_url as string | undefined;
  const pipelineSource = meta?.pipeline_source as string | undefined;

  // Filter metadata for display
  const displayMeta = meta
    ? Object.entries(meta).filter(([k]) => !HIDDEN_META_KEYS.has(k) && !k.startsWith('_'))
    : [];

  return (
    <div
      className="rounded-sm border border-white/[0.06] bg-white/[0.015] overflow-hidden cursor-pointer hover:border-[#00d4ff]/20 hover:bg-white/[0.025] transition-all duration-200 my-2"
      onClick={onView}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onView(); }}
    >
      {/* Header: Title + badges + actions */}
      <div className="px-5 pt-4 pb-3 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-[#dce3ed] truncate">{title}</h3>
          {description && (
            <p className="text-xs text-[#859398] mt-0.5 truncate">{description}</p>
          )}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            {credentialLabel && (
              <Badge className="bg-[#242b32] text-[#bbc9cf] border-[#3c494e]/30 text-[10px] font-mono">
                {credentialLabel.toLowerCase()}
              </Badge>
            )}
            {pipelineSource && (
              <span className="text-[10px] text-[#859398] uppercase tracking-wider">
                {pipelineSource === 'edgar' ? 'SEC EDGAR' : pipelineSource}
              </span>
            )}
            {sourceUrl && isSafeUrl(sourceUrl) && (
              <a
                href={sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[10px] text-[#00d4ff] hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="h-2.5 w-2.5" />
                Source
              </a>
            )}
          </div>
        </div>
        <div role="presentation" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="shrink-0 h-7 w-7 text-[#859398] hover:text-[#dce3ed]">
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
              {record.status === 'REVOKED' && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onView}>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    {REVOKED_EXPIRED_ACTIONS.REQUEST_REISSUANCE}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onView}>
                    <Mail className="mr-2 h-4 w-4" />
                    {REVOKED_EXPIRED_ACTIONS.CONTACT_ISSUER}
                  </DropdownMenuItem>
                </>
              )}
              {record.status === 'EXPIRED' && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onView}>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    {REVOKED_EXPIRED_ACTIONS.REQUEST_RENEWAL}
                  </DropdownMenuItem>
                </>
              )}
              {record.status !== 'REVOKED' && record.status !== 'EXPIRED' && (
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
      </div>

      {/* Fingerprint row */}
      <div className="px-5 pb-3">
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-[10px] uppercase tracking-wider text-[#859398] font-semibold mb-1">Unique Fingerprint</p>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-mono text-[#00d4ff] truncate">{record.fingerprint}</span>
              <CardCopyButton value={record.fingerprint} />
            </div>
          </div>
        </div>
      </div>

      {/* Anchor Record grid */}
      <div className="px-5 pb-3 border-t border-white/[0.04] pt-3">
        <p className="text-[10px] uppercase tracking-wider text-[#859398] font-semibold mb-2">Anchor Record</p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2">
          {/* Status */}
          <div>
            <p className="text-[10px] text-[#859398]">Status</p>
            <Badge className={`text-[10px] mt-0.5 ${STATUS_BADGE_CLASSES[record.status] ?? ''}`}>
              <StatusIcon className="mr-1 h-3 w-3" />
              {status.label.toUpperCase()}
            </Badge>
          </div>

          {/* Network Receipt */}
          <div>
            <p className="text-[10px] text-[#859398]">Network Receipt</p>
            {record.chainTxId ? (
              <div className="flex items-center gap-1 mt-0.5">
                <a
                  href={`${getExplorerBaseUrl()}/tx/${record.chainTxId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-[#00d4ff] hover:underline font-mono truncate"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ExternalLink className="inline h-2.5 w-2.5 mr-0.5" />
                  {record.chainTxId.slice(0, 16)}...
                </a>
                <CardCopyButton value={record.chainTxId} />
              </div>
            ) : (
              <p className="text-xs text-amber-500 mt-0.5">
                {record.status === 'SUBMITTED' ? 'Awaiting confirmation' : (record.status === 'PENDING' || record.status === 'BROADCASTING') ? 'Awaiting submission' : '\u2014'}
              </p>
            )}
          </div>

          {/* Block Height */}
          <div>
            <p className="text-[10px] text-[#859398]">Block Height</p>
            <p className="text-xs font-semibold text-[#dce3ed] mt-0.5">
              {record.chainBlockHeight ? record.chainBlockHeight.toLocaleString() : '\u2014'}
            </p>
          </div>

          {/* Network Observed Time */}
          <div>
            <p className="text-[10px] text-[#859398]">Network Observed Time</p>
            <p className="text-xs text-[#dce3ed] mt-0.5">
              {record.securedAt ? formatDateTime(record.securedAt) : formatDateTime(record.createdAt)}
            </p>
          </div>

          {/* Public ID */}
          {record.publicId && (
            <div>
              <p className="text-[10px] text-[#859398]">Public ID</p>
              <div className="flex items-center gap-1 mt-0.5">
                <span className="text-xs font-mono text-[#dce3ed]">{record.publicId}</span>
                <CardCopyButton value={record.publicId} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Metadata — key-value pairs */}
      {displayMeta.length > 0 && (
        <div className="px-5 pb-4 border-t border-white/[0.04] pt-3">
          <p className="text-[10px] uppercase tracking-wider text-[#859398] font-semibold mb-2">Metadata</p>
          <div className="space-y-1">
            {displayMeta.map(([key, value]) => (
              <div key={key} className="flex gap-4">
                <span className="text-[10px] text-[#859398] whitespace-nowrap min-w-[120px]">{key.replace(/_/g, ' ')}:</span>
                <span className="text-[10px] font-mono text-[#bbc9cf] break-all">
                  {typeof value === 'object' ? JSON.stringify(value) : String(value ?? '\u2014')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RecordSkeleton() {
  return (
    <div className="rounded-sm border border-white/[0.06] bg-white/[0.015] p-5 my-2 space-y-3">
      <Skeleton className="h-4 w-64 bg-[#242b32]" />
      <Skeleton className="h-3 w-48 bg-[#242b32]" />
      <div className="grid grid-cols-2 gap-3 pt-2">
        <Skeleton className="h-8 bg-[#242b32] rounded" />
        <Skeleton className="h-8 bg-[#242b32] rounded" />
        <Skeleton className="h-8 bg-[#242b32] rounded" />
        <Skeleton className="h-8 bg-[#242b32] rounded" />
      </div>
    </div>
  );
}

function formatDateTime(dateString: string): string {
  return new Date(dateString).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
