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
  Calendar,
  Hash,
  Lock,
  Share2,
  ExternalLink,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
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
import { CredentialRenderer } from '@/components/credentials/CredentialRenderer';
import { useCredentialTemplate } from '@/hooks/useCredentialTemplate';
import { formatFingerprint } from '@/lib/fileHasher';
import { LIFECYCLE_LABELS, CREDENTIAL_TYPE_LABELS, SHARE_LABELS, EXPLORER_LABELS } from '@/lib/copy';
import { ExplorerLink } from '@/components/ui/ExplorerLink';
import { mempoolAddressUrl } from '@/lib/platform';
import { verifyUrl } from '@/lib/routes';

interface AnchorRecord {
  id: string;
  publicId?: string;
  filename: string;
  fingerprint: string;
  status: 'PENDING' | 'SECURED' | 'REVOKED' | 'EXPIRED' | 'SUBMITTED';
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
            <Badge variant={status.variant} className="h-7">
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

          {/* Dates */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                Created
              </div>
              <p className="text-sm text-muted-foreground">
                {formatDate(anchor.createdAt)}
              </p>
            </div>
            {anchor.securedAt && (
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Lock className="h-4 w-4 text-muted-foreground" />
                  Secured
                </div>
                <p className="text-sm text-muted-foreground">
                  {formatDate(anchor.securedAt)}
                </p>
              </div>
            )}
          </div>

          {/* Description (BETA-12) */}
          {anchor.description && (
            <>
              <Separator />
              <div className="space-y-2">
                <p className="text-sm font-medium">Description</p>
                <p className="text-sm text-muted-foreground break-words">{anchor.description}</p>
              </div>
            </>
          )}

          {/* Source Document Link (pipeline records) */}
          {(() => {
            const sourceUrl = anchor.metadata?.source_url;
            const pipelineSource = String(anchor.metadata?.pipeline_source ?? '');
            const recordType = String(anchor.metadata?.record_type ?? '');
            if (typeof sourceUrl !== 'string' || !sourceUrl) return null;
            const linkLabel = pipelineSource === 'edgar' ? 'View on SEC EDGAR' :
              pipelineSource === 'openalex' ? 'View on OpenAlex' :
              pipelineSource === 'uspto' ? 'View on USPTO' :
              pipelineSource === 'federal_register' ? 'View on Federal Register' :
              'View Original Document';
            return (
              <>
                <Separator />
                <div className="space-y-2">
                  <p className="text-sm font-medium">Source Document</p>
                  <a
                    href={sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    {linkLabel}
                  </a>
                  {recordType && (
                    <p className="text-xs text-muted-foreground">
                      {recordType.replace(/_/g, ' ')}
                      {pipelineSource && ` via ${pipelineSource.toUpperCase()}`}
                    </p>
                  )}
                </div>
              </>
            );
          })()}

          {/* Network Receipt (BETA-11) */}
          {anchor.chainTxId ? (
            <>
              <Separator />
              <div className="space-y-2">
                <p className="text-sm font-medium">{EXPLORER_LABELS.NETWORK_RECEIPT}</p>
                <ExplorerLink receiptId={anchor.chainTxId} showFull />
                {anchor.chainBlockHeight && (
                  <p className="text-xs text-muted-foreground">
                    Confirmed at height {anchor.chainBlockHeight.toLocaleString()}
                  </p>
                )}
              </div>
            </>
          ) : (anchor.status === 'PENDING' || anchor.status === 'SUBMITTED') ? (
            <>
              <Separator />
              <div className="space-y-2">
                <p className="text-sm font-medium">{EXPLORER_LABELS.NETWORK_RECEIPT}</p>
                <a
                  href={mempoolAddressUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-amber-600 dark:text-amber-400 hover:underline flex items-center gap-1"
                >
                  Awaiting network confirmation — view anchor
                </a>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

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
    </div>
  );
}
