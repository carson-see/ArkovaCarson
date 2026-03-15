/**
 * Verifier Proof Download
 *
 * Allows public verifiers to download JSON proof package
 * and PDF summary from the verification page.
 *
 * @see UF-07
 */

import { useState } from 'react';
import { Download, FileJson, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { VERIFICATION_DISPLAY_LABELS } from '@/lib/copy';

interface VerifierProofDownloadProps {
  publicId: string;
  fingerprint: string;
  status: string;
  issuerName?: string | null;
  credentialType?: string | null;
  filename?: string;
  securedAt?: string | null;
  networkReceiptId?: string | null;
}

export function VerifierProofDownload({
  publicId,
  fingerprint,
  status,
  issuerName,
  credentialType,
  filename,
  securedAt,
  networkReceiptId,
}: Readonly<VerifierProofDownloadProps>) {
  const [downloading, setDownloading] = useState(false);

  const handleDownloadJson = async () => {
    setDownloading(true);
    try {
      const proof = {
        version: '1.0',
        verification_id: publicId,
        status,
        fingerprint,
        issuer: issuerName ?? undefined,
        credential_type: credentialType ?? undefined,
        filename: filename ?? undefined,
        secured_at: securedAt ?? undefined,
        network_receipt_id: networkReceiptId ?? undefined,
        verified_at: new Date().toISOString(),
        disclaimer: 'This proof package confirms the existence and status of a record anchored with Arkova. It does not assert the accuracy of the underlying document.',
      };

      const blob = new Blob([JSON.stringify(proof, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `arkova-proof-${publicId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };

  // Only show for SECURED anchors (PENDING has no proof yet)
  if (status === 'PENDING') return null;

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <Download className="h-3.5 w-3.5" />
        {VERIFICATION_DISPLAY_LABELS.DOWNLOAD_PROOF}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleDownloadJson}
          disabled={downloading}
          className="gap-1.5"
        >
          {downloading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FileJson className="h-3.5 w-3.5" />
          )}
          {VERIFICATION_DISPLAY_LABELS.DOWNLOAD_JSON}
        </Button>
      </div>
    </div>
  );
}
