/**
 * Verifier Proof Download
 *
 * Allows public verifiers to download JSON proof package
 * and PDF summary from the verification page.
 *
 * CSI-03: Enriched with evidence_package_hash, source_payload_hash,
 * source_provider, source_url, fetched_at, verification_level.
 *
 * @see UF-07, CSI-03 / SCRUM-1599
 */

import { useState } from 'react';
import { Download, FileJson, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { VERIFICATION_DISPLAY_LABELS } from '@/lib/copy';
import { hasPublicVerificationProof, normalizePublicVerificationStatus } from '@/lib/publicVerificationState';
import { buildEvidenceProofFields, type SourceProvenanceData } from '@/lib/sourceProvenance';

interface VerifierProofDownloadProps {
  publicId: string;
  fingerprint: string;
  status: string;
  issuerName?: string | null;
  credentialType?: string | null;
  filename?: string;
  securedAt?: string | null;
  networkReceiptId?: string | null;
  /** CSI-03: Source provenance metadata for enriched proof package */
  sourceProvenance?: SourceProvenanceData | null;
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
  sourceProvenance,
}: Readonly<VerifierProofDownloadProps>) {
  const [downloading, setDownloading] = useState(false);
  const publicStatus = normalizePublicVerificationStatus(status);

  const handleDownloadJson = async () => {
    setDownloading(true);
    try {
      // CSI-03: Build evidence fields from source provenance
      const evidenceFields = sourceProvenance
        ? buildEvidenceProofFields(sourceProvenance)
        : {};

      const proof = {
        version: '1.1',
        verification_id: publicId,
        status: publicStatus,
        fingerprint,
        issuer: issuerName ?? undefined,
        credential_type: credentialType ?? undefined,
        filename: filename ?? undefined,
        secured_at: securedAt ?? undefined,
        network_receipt_id: networkReceiptId ?? undefined,
        // CSI-03: Evidence provenance fields
        ...evidenceFields,
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

  if (!hasPublicVerificationProof(publicStatus)) return null;

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
