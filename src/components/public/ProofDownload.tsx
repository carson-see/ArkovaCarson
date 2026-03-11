/**
 * Proof Download Component
 *
 * Displays proof/receipt information and download options.
 * Uses approved terminology (Network Receipt, not Transaction).
 */

import { Download, Shield, FileText, Calendar, ExternalLink, Copy, Check } from 'lucide-react';
import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';

interface ProofData {
  recordId: string;
  filename: string;
  fingerprint: string;
  status: 'SECURED';
  createdAt: string;
  securedAt: string;
  networkReceipt: {
    id: string;
    timestamp: string;
    confirmations: number;
  };
}

interface ProofDownloadProps {
  proof: ProofData;
  onDownloadPDF?: () => void;
  onDownloadJSON?: () => void;
}

export function ProofDownload({
  proof,
  onDownloadPDF,
  onDownloadJSON,
}: Readonly<ProofDownloadProps>) {
  const [copied, setCopied] = useState(false);

  const handleCopyFingerprint = useCallback(async () => {
    await navigator.clipboard.writeText(proof.fingerprint);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [proof.fingerprint]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-success" />
              Proof of Record
            </CardTitle>
            <CardDescription>
              Cryptographic proof that this document was secured
            </CardDescription>
          </div>
          <Badge variant="success">Verified</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Document info */}
        <div className="rounded-lg border p-4 space-y-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
              <FileText className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate">{proof.filename}</p>
              <p className="text-xs text-muted-foreground">
                Secured on {formatDate(proof.securedAt)}
              </p>
            </div>
          </div>

          <Separator />

          {/* Fingerprint */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-muted-foreground">Document Fingerprint</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2"
                onClick={handleCopyFingerprint}
              >
                {copied ? (
                  <>
                    <Check className="h-3 w-3 mr-1" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3 mr-1" />
                    Copy
                  </>
                )}
              </Button>
            </div>
            <p className="text-xs font-mono bg-muted rounded px-2 py-1 break-all">
              {proof.fingerprint}
            </p>
          </div>
        </div>

        {/* Network receipt info */}
        <div className="space-y-3">
          <h4 className="text-sm font-medium flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            Network Receipt
          </h4>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground mb-1">Receipt ID</p>
              <p className="font-mono text-xs truncate">{proof.networkReceipt.id}</p>
            </div>
            <div>
              <p className="text-muted-foreground mb-1">Timestamp</p>
              <p className="text-xs">{formatDateTime(proof.networkReceipt.timestamp)}</p>
            </div>
            <div>
              <p className="text-muted-foreground mb-1">Confirmations</p>
              <p className="font-medium">{proof.networkReceipt.confirmations}</p>
            </div>
            <div>
              <p className="text-muted-foreground mb-1">Status</p>
              <Badge variant="success" className="text-xs">Confirmed</Badge>
            </div>
          </div>
        </div>

        <Separator />

        {/* Download options */}
        <div className="space-y-3">
          <h4 className="text-sm font-medium">Download Proof</h4>
          <div className="flex gap-3">
            <Button variant="outline" className="flex-1" onClick={onDownloadPDF}>
              <Download className="mr-2 h-4 w-4" />
              PDF Certificate
            </Button>
            <Button variant="outline" className="flex-1" onClick={onDownloadJSON}>
              <Download className="mr-2 h-4 w-4" />
              JSON Data
            </Button>
          </div>
          <p className="text-xs text-muted-foreground text-center">
            These files contain all information needed to independently verify this record.
          </p>
        </div>

        {/* External verification link */}
        <div className="rounded-lg bg-muted/50 p-3 text-center">
          <p className="text-xs text-muted-foreground mb-2">
            Verify this record independently
          </p>
          <Button variant="link" size="sm" className="h-auto p-0">
            Open in Explorer
            <ExternalLink className="ml-1 h-3 w-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatDateTime(dateString: string): string {
  return new Date(dateString).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
