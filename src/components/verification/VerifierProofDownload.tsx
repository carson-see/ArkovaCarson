/**
 * Verifier Proof Download
 *
 * Allows public verifiers to download the canonical proof bundle from the
 * verification page.
 *
 * FE-PROOF-GATE (SCRUM-2501): the legacy proof download here was a
 * hand-assembled JSON subset gated purely on `status === SECURED`. The real
 * `/api/v1/verify/:publicId/proof` endpoint is proof-EXISTENCE-gated, not
 * status-gated (docs/reference/FE_PROOF_GATE_CONTRACT.md §1.3) — a SECURED
 * record may still have no downloadable Merkle proof (the ~2.97M
 * direct-anchored back catalogue never got an app-tree branch). This
 * component now calls that endpoint and renders one of:
 *   - state 1  (200 + verified + proof_bundle)  -> live download, verbatim bundle
 *   - state 1b (200 + proof_bundle: null)        -> honest empty-state (no control)
 *   - state 2  (404 "No Merkle proof available…") -> honest empty-state (no control)
 *   - record-missing (404 "Record not found")     -> real error state
 *   - transient (429)                             -> render nothing
 *   - retry (5xx / verified:false / network fail) -> retryable affordance
 *
 * The downloaded artifact is the `proof_bundle` object returned by the API,
 * VERBATIM — never a hand-assembled subset (contract §3, state 1).
 *
 * @see UF-07 / SCRUM-1599, FE-PROOF-GATE / SCRUM-2501
 */

import { useState } from 'react';
import { AlertCircle, Download, FileJson, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PROOF_AVAILABILITY_LABELS, VERIFICATION_DISPLAY_LABELS } from '@/lib/copy';
import { isProofDownloadable, normalizePublicVerificationStatus } from '@/lib/publicVerificationState';
import { useProofAvailability } from '@/hooks/useProofAvailability';

interface VerifierProofDownloadProps {
  publicId: string;
  status: string;
}

function downloadJson(filenameSuffix: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filenameSuffix;
  a.click();
  URL.revokeObjectURL(url);
}

export function VerifierProofDownload({
  publicId,
  status,
}: Readonly<VerifierProofDownloadProps>) {
  const [downloading, setDownloading] = useState(false);
  const publicStatus = normalizePublicVerificationStatus(status);

  // FE-PROOF-GATE (SCRUM-2501): SECURED-only belt-and-braces check (contract §3).
  // A REVOKED/EXPIRED/SUPERSEDED anchor must NOT expose a downloadable proof,
  // even though it still HAS a record — and the /proof fetch is only ever
  // mounted once this is true, per useProofAvailability's contract.
  const gateOpen = isProofDownloadable(publicStatus);

  const { state, proofBundle, loading, retry } = useProofAvailability(publicId, gateOpen);

  if (!gateOpen) return null;

  const handleDownloadBundle = () => {
    if (!proofBundle) return;
    setDownloading(true);
    try {
      // The downloaded artifact is the proof_bundle object VERBATIM — never a
      // hand-assembled subset (contract §3, state 1 requirement).
      downloadJson(`arkova-proof-${publicId}.json`, proofBundle);
    } finally {
      setDownloading(false);
    }
  };

  // Loading: avoid flashing the empty-state copy while the fetch is in flight.
  if (loading) {
    return (
      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <Download className="h-3.5 w-3.5" />
          {VERIFICATION_DISPLAY_LABELS.DOWNLOAD_PROOF}
        </p>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        </div>
      </div>
    );
  }

  // 429 — transient. Render neither the empty-state nor an error.
  if (state === 'transient') {
    return null;
  }

  // Record not found — a real error state, distinct from the honest state-2 empty-state.
  if (state === 'record-missing') {
    return (
      <div className="space-y-2" data-testid="proof-record-missing">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <AlertCircle className="h-3.5 w-3.5" />
          {VERIFICATION_DISPLAY_LABELS.DOWNLOAD_PROOF}
        </p>
        <p className="text-sm text-muted-foreground">{PROOF_AVAILABILITY_LABELS.RECORD_MISSING}</p>
      </div>
    );
  }

  // 5xx / verified:false / network failure — retryable, never state-2 copy.
  if (state === 'retry') {
    return (
      <div className="space-y-2" data-testid="proof-retry">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <AlertCircle className="h-3.5 w-3.5" />
          {PROOF_AVAILABILITY_LABELS.RETRY_TITLE}
        </p>
        <p className="text-sm text-muted-foreground">{PROOF_AVAILABILITY_LABELS.RETRY_BODY}</p>
        <Button variant="outline" size="sm" onClick={retry} className="gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" />
          {PROOF_AVAILABILITY_LABELS.RETRY_BUTTON}
        </Button>
      </div>
    );
  }

  // State 1b / state 2 — the honest empty-state. NO download control, NO
  // disabled button, NO error toast (contract §3.1).
  if (state === 'empty') {
    return (
      <div className="space-y-1.5" data-testid="proof-not-yet-available">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5" />
          {PROOF_AVAILABILITY_LABELS.NOT_YET_AVAILABLE_TITLE}
        </p>
        <p className="text-sm text-muted-foreground">{PROOF_AVAILABILITY_LABELS.NOT_YET_AVAILABLE_BODY}</p>
      </div>
    );
  }

  // State 1 — live download control. Artifact = proof_bundle verbatim.
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
          onClick={handleDownloadBundle}
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
