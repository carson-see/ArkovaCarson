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
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FileUpload } from './FileUpload';
import { AnchorLifecycleTimeline } from './AnchorLifecycleTimeline';
import { formatFingerprint } from '@/lib/fileHasher';
import { LIFECYCLE_LABELS } from '@/lib/copy';
import { verifyPath } from '@/lib/routes';

interface AnchorRecord {
  id: string;
  publicId?: string;
  filename: string;
  fingerprint: string;
  status: 'PENDING' | 'SECURED' | 'REVOKED' | 'EXPIRED';
  createdAt: string;
  securedAt?: string;
  issuedAt?: string;
  revokedAt?: string;
  revocationReason?: string;
  expiresAt?: string;
  fileSize: number;
  fileMime?: string;
}

interface AssetDetailViewProps {
  anchor: AnchorRecord;
  onBack?: () => void;
  onDownloadProof?: () => void;
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
    variant: 'secondary' as const,
    icon: XCircle,
    color: 'text-gray-500',
  },
  EXPIRED: {
    label: 'Expired',
    variant: 'secondary' as const,
    icon: AlertTriangle,
    color: 'text-gray-500',
  },
};

export function AssetDetailView({ anchor, onBack, onDownloadProof }: AssetDetailViewProps) {
  const [copied, setCopied] = useState(false);
  const [verificationState, setVerificationState] = useState<VerificationState>('idle');
  const [showVerifyDropzone, setShowVerifyDropzone] = useState(false);

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
        </CardContent>
      </Card>

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
            <div className="rounded-lg border bg-white p-4">
              <QRCodeSVG
                value={`${window.location.origin}${verifyPath(anchor.publicId)}`}
                size={180}
                level="M"
              />
            </div>
            <p className="text-xs text-muted-foreground text-center">
              {window.location.origin}{verifyPath(anchor.publicId)}
            </p>
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

      {/* Actions */}
      {anchor.status === 'SECURED' && onDownloadProof && (
        <Card>
          <CardContent className="flex items-center justify-between py-4">
            <div>
              <p className="text-sm font-medium">Download Proof Package</p>
              <p className="text-xs text-muted-foreground">
                Get a complete verification package with all metadata
              </p>
            </div>
            <Button onClick={onDownloadProof}>
              <Download className="mr-2 h-4 w-4" />
              Download
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
