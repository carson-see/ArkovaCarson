/**
 * Asset Detail View
 *
 * Certificate-like anchor details page with re-verification flow.
 */

import { useState, useCallback } from 'react';
import {
  Shield,
  FileText,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  Copy,
  Check,
  RefreshCw,
  Download,
  ArrowLeft,
  Hash,
  Share2,
  ExternalLink,
  GitBranch,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { ComplianceBadge } from './ComplianceBadge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FileUpload } from './FileUpload';
import { ShareSheet } from './ShareSheet';
import { LinkedInShareButton, LinkedInBadgeSnippet } from './LinkedInShare';
import { AnchorLifecycleTimeline } from './AnchorLifecycleTimeline';
import { VerificationWalkthrough } from './VerificationWalkthrough';
import { AnchorDisclaimer } from './AnchorDisclaimer';
import { CredentialRenderer } from '@/components/credentials/CredentialRenderer';
import { useCredentialTemplate } from '@/hooks/useCredentialTemplate';
import { formatFingerprint } from '@/lib/fileHasher';
import { LIFECYCLE_LABELS, CREDENTIAL_TYPE_LABELS, SHARE_LABELS, EXPLORER_LABELS, FINGERPRINT_TOOLTIP, VERSION_HISTORY_LABELS } from '@/lib/copy';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from '@/components/ui/tooltip';
import { verifyUrl } from '@/lib/routes';
import { getExplorerBaseUrl } from '@/components/ui/ExplorerLink';

/** Inline copy button for values */
function CopyButton({ value }: { value: string }) {
  const [justCopied, setJustCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center justify-center h-5 w-5 rounded text-muted-foreground hover:text-foreground transition-colors"
      onClick={async () => {
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

interface AnchorRecord {
  id: string;
  publicId?: string;
  filename: string;
  fingerprint: string;
  status: 'PENDING' | 'BROADCASTING' | 'SECURED' | 'REVOKED' | 'EXPIRED' | 'SUBMITTED';
  createdAt: string;
  securedAt?: string;
  issuedAt?: string;
  revokedAt?: string;
  revocationReason?: string;
  expiresAt?: string;
  fileSize: number;
  fileMime?: string;
  credentialType?: string;
  orgId?: string;
  metadata?: Record<string, unknown> | null;
  issuerName?: string;
  /** Chain transaction ID for explorer link (BETA-11) */
  chainTxId?: string | null;
  /** Chain block height (BETA-11) */
  chainBlockHeight?: number | null;
  /** Immutable description set at creation (BETA-12) */
  description?: string | null;
  /** Version number in lineage chain (1 = original) */
  versionNumber?: number;
  /** Parent anchor ID for lineage navigation */
  parentAnchorId?: string | null;
  /** Lineage chain: all versions of this credential */
  lineage?: { id: string; versionNumber: number; status: string; createdAt: string; filename: string }[];
}

interface AssetDetailViewProps {
  anchor: AnchorRecord;
  onBack?: () => void;
  onDownloadProof?: () => void;
  onDownloadProofJson?: () => void;
}

type VerificationState = 'idle' | 'verifying' | 'match' | 'mismatch';

const statusConfig = {
  PENDING: {
    label: 'Pending',
    variant: 'warning' as const,
    icon: Clock,
    color: 'text-yellow-600',
  },
  BROADCASTING: {
    label: 'Pending',
    variant: 'warning' as const,
    icon: Clock,
    color: 'text-yellow-600',
  },
  SECURED: {
    label: 'Secured',
    variant: 'success' as const,
    icon: CheckCircle,
    color: 'text-green-600',
  },
  REVOKED: {
    label: 'Revoked',
    variant: 'destructive' as const,
    icon: XCircle,
    color: 'text-red-600',
  },
  EXPIRED: {
    label: 'Expired',
    variant: 'outline' as const,
    icon: AlertTriangle,
    color: 'text-amber-600',
  },
  SUBMITTED: {
    label: 'Submitted',
    variant: 'secondary' as const,
    icon: Clock,
    color: 'text-blue-600',
  },
};

export function AssetDetailView({ anchor, onBack, onDownloadProof, onDownloadProofJson }: Readonly<AssetDetailViewProps>) {
  const [copied, setCopied] = useState(false);
  const [verificationState, setVerificationState] = useState<VerificationState>('idle');
  const [showVerifyDropzone, setShowVerifyDropzone] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  // Fetch template for credential rendering (UF-01)
  const { template } = useCredentialTemplate(anchor.credentialType, anchor.orgId);

  const status = statusConfig[anchor.status];
  const StatusIcon = status.icon;

  const handleCopyFingerprint = async () => {
    await navigator.clipboard.writeText(anchor.fingerprint);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleVerifyFile = useCallback(
    async (_file: File, fingerprint: string) => {
      setVerificationState('verifying');

      // Small delay to show loading state
      await new Promise((resolve) => setTimeout(resolve, 500));

      const isMatch = fingerprint.toLowerCase() === anchor.fingerprint.toLowerCase();
      setVerificationState(isMatch ? 'match' : 'mismatch');
    },
    [anchor.fingerprint]
  );

  const handleResetVerification = () => {
    setVerificationState('idle');
    setShowVerifyDropzone(false);
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDate = (dateString: string): string => {
    return new Date(dateString).toLocaleString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        {onBack && (
          <Button variant="ghost" size="icon" onClick={onBack}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
        )}
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Record Details</h1>
          <p className="text-muted-foreground">
            View and verify your secured document
          </p>
        </div>
        {anchor.publicId && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setShareOpen(true)}>
              <Share2 className="mr-2 h-4 w-4" />
              {SHARE_LABELS.SHARE_BUTTON}
            </Button>
            <LinkedInShareButton
              publicId={anchor.publicId}
              credentialType={anchor.credentialType ? CREDENTIAL_TYPE_LABELS[anchor.credentialType as keyof typeof CREDENTIAL_TYPE_LABELS] : undefined}
            />
            <LinkedInBadgeSnippet
              publicId={anchor.publicId}
              status={anchor.status}
            />
          </div>
        )}
      </div>

      {/* Certificate Card */}
      <Card className="overflow-hidden">
        <div className="bg-gradient-to-r from-primary/10 to-primary/5 px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-background shadow-sm">
                <Shield className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h2 className="font-semibold">Verification Certificate</h2>
                <p className="text-sm text-muted-foreground">
                  Arkova Secure Record
                </p>
              </div>
            </div>
            <Badge variant={status.variant} className={`h-7 ${anchor.status === 'SECURED' ? 'animate-secured animate-status-pulse' : ''}`}>
              <StatusIcon className="mr-1 h-3.5 w-3.5" />
              {status.label}
            </Badge>
          </div>
        </div>

        <CardContent className="p-6 space-y-6">
          {/* Document Info */}
          <div className="flex items-start gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-muted shrink-0">
              <FileText className="h-7 w-7 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-lg font-medium truncate">{anchor.filename}</p>
              <p className="text-sm text-muted-foreground">
                {formatFileSize(anchor.fileSize)}
                {anchor.fileMime && ` • ${anchor.fileMime}`}
                {anchor.credentialType && ` • ${CREDENTIAL_TYPE_LABELS[anchor.credentialType as keyof typeof CREDENTIAL_TYPE_LABELS] ?? anchor.credentialType}`}
              </p>
            </div>
          </div>

          <Separator />

          {/* Fingerprint */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Hash className="h-4 w-4 text-muted-foreground" />
                Document Fingerprint
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button type="button" className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground hover:bg-muted/80 cursor-help" aria-label={FINGERPRINT_TOOLTIP.TITLE}>?</button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      <p className="text-xs font-medium mb-1">{FINGERPRINT_TOOLTIP.TITLE}</p>
                      <p className="text-xs text-muted-foreground">{FINGERPRINT_TOOLTIP.DESCRIPTION}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={handleCopyFingerprint}
              >
                {copied ? (
                  <>
                    <Check className="mr-1 h-3 w-3" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="mr-1 h-3 w-3" />
                    Copy
                  </>
                )}
              </Button>
            </div>
            <div className="p-4 rounded-lg bg-muted font-mono text-xs break-all">
              {anchor.fingerprint}
            </div>
            <p className="text-xs text-muted-foreground">
              SHA-256 cryptographic hash • {formatFingerprint(anchor.fingerprint, 8, 4)}
            </p>
          </div>

          <Separator />

          {/* ANCHOR RECORD — pipeline-style 2-column grid */}
          <div className="space-y-4">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Anchor Record</span>
            <div className="grid gap-4 sm:grid-cols-2">
              {/* Status */}
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Status</p>
                <Badge
                  variant={status.variant}
                  className={`text-xs ${anchor.status === 'SECURED' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : anchor.status === 'SUBMITTED' ? 'bg-amber-500/10 text-amber-400 border-amber-500/30' : ''}`}
                >
                  {status.label.toUpperCase()}
                </Badge>
              </div>

              {/* Network Receipt */}
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">{EXPLORER_LABELS.NETWORK_RECEIPT}</p>
                {anchor.chainTxId ? (
                  <div className="flex items-center gap-1.5">
                    <a
                      href={`${getExplorerBaseUrl()}/tx/${anchor.chainTxId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-[#00d4ff] hover:underline font-mono truncate"
                    >
                      <ExternalLink className="inline h-3 w-3 mr-1" />
                      {anchor.chainTxId.slice(0, 16)}…
                    </a>
                    <CopyButton value={anchor.chainTxId} />
                  </div>
                ) : (
                  <p className="text-xs text-amber-500">
                    {anchor.status === 'SUBMITTED' ? 'Awaiting confirmation' : anchor.status === 'PENDING' ? 'Awaiting submission' : '—'}
                  </p>
                )}
              </div>

              {/* Block Height */}
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Block Height</p>
                <p className="text-sm font-semibold">
                  {anchor.chainBlockHeight ? anchor.chainBlockHeight.toLocaleString() : '—'}
                </p>
              </div>

              {/* Network Observed Time */}
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Network Observed Time</p>
                <p className="text-sm">
                  {anchor.securedAt ? formatDate(anchor.securedAt) : formatDate(anchor.createdAt)}
                </p>
              </div>

              {/* Public ID */}
              {anchor.publicId && (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Public ID</p>
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-mono">{anchor.publicId}</span>
                    <CopyButton value={anchor.publicId} />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Description (BETA-12) */}
          {anchor.description && (
            <>
              <Separator />
              <div className="space-y-2">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Description</span>
                <p className="text-sm text-muted-foreground break-words">{anchor.description}</p>
              </div>
            </>
          )}

          {/* Source Document Link (pipeline records) */}
          {(() => {
            const sourceUrl = anchor.metadata?.source_url;
            const pipelineSource = String(anchor.metadata?.pipeline_source ?? '');
            const _recordType = String(anchor.metadata?.record_type ?? '');
            if (typeof sourceUrl !== 'string' || !sourceUrl) return null;
            const linkLabel = pipelineSource === 'edgar' ? 'SEC EDGAR' :
              pipelineSource === 'openalex' ? 'OpenAlex' :
              pipelineSource === 'uspto' ? 'USPTO' :
              pipelineSource === 'federal_register' ? 'Federal Register' :
              'Source';
            return (
              <>
                <Separator />
                <div className="space-y-2">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Source</span>
                  <a
                    href={sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm text-[#00d4ff] hover:underline"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    {linkLabel}
                  </a>
                </div>
              </>
            );
          })()}

          {/* AI Tags — displayed as badges when present */}
          {Array.isArray(anchor.metadata?.ai_tags) && (anchor.metadata!.ai_tags as string[]).length > 0 && (
            <>
              <Separator />
              <div className="space-y-2">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Tags</span>
                <div className="flex flex-wrap gap-1.5">
                  {(anchor.metadata.ai_tags as string[]).map(tag => (
                    <Badge key={tag} variant="secondary" className="text-xs font-normal">
                      {tag}
                    </Badge>
                  ))}
                </div>
                {typeof anchor.metadata?.ai_summary === 'string' && anchor.metadata.ai_summary && (
                  <p className="text-xs text-muted-foreground mt-1">{anchor.metadata.ai_summary}</p>
                )}
              </div>
            </>
          )}

          {/* Compliance Controls (CML-01) */}
          {anchor.status === 'SECURED' && (
            <>
              <Separator />
              <ComplianceBadge
                credentialType={anchor.credentialType}
                isSecured={true}
              />
            </>
          )}

          {/* METADATA — pipeline-style key-value pairs */}
          {anchor.metadata && Object.keys(anchor.metadata).filter(k => !['pipeline_source', 'source_url', 'abstract', 'description', 'summary', 'merkle_proof', 'merkle_root', 'merkle_index', 'batch_id', 'ai_tags', 'ai_summary', 'ai_document_type'].includes(k)).length > 0 && (
            <>
              <Separator />
              <div className="space-y-3">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Metadata</span>
                <div className="space-y-2">
                  {Object.entries(anchor.metadata)
                    .filter(([k]) => !['pipeline_source', 'source_url', 'abstract', 'description', 'summary', 'merkle_proof', 'merkle_root', 'merkle_index', 'batch_id', 'ai_tags', 'ai_summary', 'ai_document_type'].includes(k))
                    .map(([key, value]) => (
                      <div key={key} className="flex gap-4">
                        <span className="text-xs text-muted-foreground whitespace-nowrap min-w-[120px]">{key.replace(/_/g, ' ')}:</span>
                        <span className="text-xs font-mono break-all">{typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—')}</span>
                      </div>
                    ))
                  }
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Live anchoring progress indicator (Design Audit #16) */}
      {(anchor.status === 'PENDING' || anchor.status === 'SUBMITTED') && (
        <Card className="border-amber-500/20 bg-amber-500/5">
          <CardContent className="py-4">
            <div className="flex items-center gap-4">
              <div className="relative flex h-10 w-10 items-center justify-center">
                <div className="absolute inset-0 animate-ping rounded-full bg-amber-500/20" />
                <Clock className="relative h-5 w-5 text-amber-500" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium">
                  {anchor.status === 'SUBMITTED' ? 'Awaiting network confirmation' : 'Preparing for anchoring'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {anchor.status === 'SUBMITTED'
                    ? 'Your record has been submitted to the network. Confirmation typically takes ~10 minutes.'
                    : 'Your record is being prepared for permanent anchoring.'}
                </p>
              </div>
              <Badge variant="secondary" className="text-xs shrink-0">
                {anchor.status === 'SUBMITTED' ? 'Confirming' : 'Queued'}
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Verification Walkthrough (DEMO-02) */}
      <VerificationWalkthrough hasMetadata={!!anchor.metadata && Object.keys(anchor.metadata).length > 0} />

      {/* Credential Details (UF-01) — template-driven rendering */}
      {(anchor.credentialType || anchor.metadata) && (
        <CredentialRenderer
          credentialType={anchor.credentialType}
          metadata={anchor.metadata ?? undefined}
          template={template}
          issuerName={anchor.issuerName}
          status={anchor.status}
          filename={anchor.filename}
          issuedDate={anchor.issuedAt}
          expiryDate={anchor.expiresAt}
        />
      )}

      {/* Lifecycle Timeline */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4" />
            {LIFECYCLE_LABELS.TITLE}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <AnchorLifecycleTimeline
            data={{
              status: anchor.status,
              createdAt: anchor.createdAt,
              issuedAt: anchor.issuedAt,
              securedAt: anchor.securedAt,
              revokedAt: anchor.revokedAt,
              revocationReason: anchor.revocationReason,
              expiresAt: anchor.expiresAt,
            }}
          />
        </CardContent>
      </Card>

      {/* Version History / Lineage (P4-TS-06) */}
      {(anchor.versionNumber ?? 1) > 1 || (anchor.lineage && anchor.lineage.length > 1) ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <GitBranch className="h-4 w-4" />
              {VERSION_HISTORY_LABELS.TITLE}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {(anchor.lineage ?? [{ id: anchor.id, versionNumber: anchor.versionNumber ?? 1, status: anchor.status, createdAt: anchor.createdAt, filename: anchor.filename }]).map((version) => {
                const isCurrent = version.id === anchor.id;
                const vStatus = statusConfig[version.status as keyof typeof statusConfig];
                const VIcon = vStatus?.icon ?? Clock;
                return (
                  <div
                    key={version.id}
                    className={`flex items-center gap-3 rounded-lg px-4 py-3 transition-colors ${isCurrent ? 'bg-primary/5 border border-primary/20' : 'bg-muted/50 hover:bg-muted cursor-pointer'}`}
                    onClick={!isCurrent ? () => window.location.assign(`/records/${version.id}`) : undefined}
                    role={!isCurrent ? 'link' : undefined}
                  >
                    <div className={`flex h-8 w-8 items-center justify-center rounded-full shrink-0 ${isCurrent ? 'bg-primary/10' : 'bg-muted'}`}>
                      <span className="text-xs font-bold">{version.versionNumber}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {VERSION_HISTORY_LABELS.VERSION_PREFIX} {version.versionNumber}
                        {isCurrent && (
                          <Badge variant="outline" className="ml-2 text-[10px]">{VERSION_HISTORY_LABELS.CURRENT}</Badge>
                        )}
                        {version.versionNumber === 1 && (
                          <span className="ml-2 text-xs text-muted-foreground">{VERSION_HISTORY_LABELS.ORIGINAL}</span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {version.filename} — {new Date(version.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </p>
                    </div>
                    <Badge variant={vStatus?.variant ?? 'outline'} className="shrink-0">
                      <VIcon className="mr-1 h-3 w-3" />
                      {vStatus?.label ?? version.status}
                    </Badge>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* QR Code — only for SECURED anchors with a public_id */}
      {anchor.publicId && anchor.status === 'SECURED' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Verification QR Code
            </CardTitle>
            <CardDescription>
              Share this QR code to let anyone verify this document
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            <div id="qr-code-container" className="rounded-lg border bg-white p-4">
              <QRCodeSVG
                value={verifyUrl(anchor.publicId)}
                size={180}
                level="M"
              />
            </div>
            <p className="text-xs text-muted-foreground text-center">
              {verifyUrl(anchor.publicId)}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const svg = document.querySelector('#qr-code-container svg');
                if (!svg) return;
                const canvas = document.createElement('canvas');
                canvas.width = 220;
                canvas.height = 220;
                const ctx = canvas.getContext('2d');
                if (!ctx) return;
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, 220, 220);
                const svgData = new XMLSerializer().serializeToString(svg);
                const img = new Image();
                img.onload = () => {
                  ctx.drawImage(img, 20, 20, 180, 180);
                  const link = document.createElement('a');
                  link.download = `arkova-qr-${(anchor.publicId ?? 'unknown').slice(0, 8)}.png`;
                  link.href = canvas.toDataURL('image/png');
                  link.click();
                };
                img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
              }}
            >
              <Download className="mr-2 h-3.5 w-3.5" />
              Download QR as PNG
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Re-verify Section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <RefreshCw className="h-4 w-4" />
            Re-verify Document
          </CardTitle>
          <CardDescription>
            Drop your original document to verify it matches this record
          </CardDescription>
        </CardHeader>
        <CardContent>
          {verificationState === 'idle' && !showVerifyDropzone && (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setShowVerifyDropzone(true)}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Verify Document
            </Button>
          )}

          {showVerifyDropzone && verificationState === 'idle' && (
            <div className="space-y-4">
              <FileUpload onFileSelect={handleVerifyFile} disabled={false} />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowVerifyDropzone(false)}
              >
                Cancel
              </Button>
            </div>
          )}

          {verificationState === 'verifying' && (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="h-6 w-6 animate-spin text-primary" />
              <span className="ml-2 text-sm">Verifying document...</span>
            </div>
          )}

          {verificationState === 'match' && (
            <Alert className="border-green-200 bg-green-50 dark:bg-green-950/20">
              <CheckCircle className="h-5 w-5 text-green-600" />
              <AlertDescription className="text-green-800 dark:text-green-200">
                <strong>Verification Successful!</strong>
                <br />
                The document fingerprint matches. This is the authentic document.
              </AlertDescription>
            </Alert>
          )}

          {verificationState === 'mismatch' && (
            <Alert variant="destructive">
              <XCircle className="h-5 w-5" />
              <AlertDescription>
                <strong>Verification Failed!</strong>
                <br />
                The document fingerprint does not match. This may be a modified or different document.
              </AlertDescription>
            </Alert>
          )}

          {(verificationState === 'match' || verificationState === 'mismatch') && (
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={handleResetVerification}
            >
              Verify Another Document
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Share Sheet (UF-08) */}
      {anchor.publicId && (
        <ShareSheet
          open={shareOpen}
          onOpenChange={setShareOpen}
          publicId={anchor.publicId}
          filename={anchor.filename}
        />
      )}

      {/* Actions */}
      {anchor.status === 'SECURED' && (onDownloadProof || onDownloadProofJson) && (
        <Card>
          <CardContent className="flex items-center justify-between py-4">
            <div>
              <p className="text-sm font-medium">Download Proof Package</p>
              <p className="text-xs text-muted-foreground">
                Get a complete verification package with all metadata
              </p>
            </div>
            <div className="flex gap-2">
              {onDownloadProof && (
                <Button onClick={onDownloadProof} variant="outline">
                  <Download className="mr-2 h-4 w-4" />
                  PDF
                </Button>
              )}
              {onDownloadProofJson && (
                <Button onClick={onDownloadProofJson}>
                  <Download className="mr-2 h-4 w-4" />
                  JSON
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Platform Disclaimer (IDT WS3) */}
      <AnchorDisclaimer />
    </div>
  );
}
