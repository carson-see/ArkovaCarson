/**
 * Verification Result Display (SCRUM-1874)
 *
 * Shows the result of verifying an attestation against the network.
 * Displays chain proof data (network receipt, checkpoint, observed time),
 * fingerprint, and copy-to-clipboard functionality.
 *
 * Uses CLAUDE.md-compliant terminology throughout:
 *   - "Network Receipt" (not "transaction")
 *   - "Network Checkpoint" (not "block height")
 *   - "Fingerprint" (not "hash")
 *   - "Network Observed Time" (not "block time")
 */

import { useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Shield,
  CheckCircle,
  XCircle,
  Clock,
  ExternalLink,
  Copy,
  Check,
} from 'lucide-react';
import { ATTESTATION_LABELS } from '@/lib/copy';

interface ChainProof {
  tx_id: string;
  block_height: number | null;
  timestamp: string | null;
  explorer_url: string | null;
}

interface VerificationResultDisplayProps {
  status: string;
  fingerprint?: string | null;
  chainProof: ChainProof | null;
}

type VerificationState = 'passed' | 'failed' | 'pending';

function resolveVerificationState(status: string, chainProof: ChainProof | null): VerificationState {
  if (status === 'REVOKED' || status === 'EXPIRED') return 'failed';
  if (status === 'CHALLENGED') return 'failed';
  if (status === 'PENDING' || status === 'DRAFT' || !chainProof) return 'pending';
  return 'passed';
}

const STATE_CONFIG: Record<VerificationState, {
  icon: typeof CheckCircle;
  color: string;
  bg: string;
  label: string;
  description: string;
}> = {
  passed: {
    icon: CheckCircle,
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10',
    label: ATTESTATION_LABELS.VERIFICATION_PASSED,
    description: ATTESTATION_LABELS.VERIFICATION_PASSED_DESC,
  },
  failed: {
    icon: XCircle,
    color: 'text-red-400',
    bg: 'bg-red-500/10',
    label: ATTESTATION_LABELS.VERIFICATION_FAILED,
    description: ATTESTATION_LABELS.VERIFICATION_FAILED_DESC,
  },
  pending: {
    icon: Clock,
    color: 'text-amber-400',
    bg: 'bg-amber-500/10',
    label: ATTESTATION_LABELS.VERIFICATION_PENDING,
    description: ATTESTATION_LABELS.VERIFICATION_PENDING_DESC,
  },
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function VerificationResultDisplay({
  status,
  fingerprint,
  chainProof,
}: VerificationResultDisplayProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const handleCopy = useCallback((text: string, field: string) => {
    navigator.clipboard.writeText(text).catch(() => { /* clipboard unavailable */ });
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  }, []);

  const verificationState = resolveVerificationState(status, chainProof);
  const config = STATE_CONFIG[verificationState];
  const Icon = config.icon;

  return (
    <Card className="border-[#00d4ff]/10 bg-[#192028]">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Shield className="h-5 w-5 text-[#00d4ff]" />
          {ATTESTATION_LABELS.VERIFICATION_RESULT_TITLE}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Status banner */}
        <div className={`flex items-center gap-3 rounded-sm p-3 ${config.bg}`}>
          <Icon className={`h-5 w-5 ${config.color} shrink-0`} />
          <div>
            <p className={`font-semibold ${config.color}`}>{config.label}</p>
            <p className="text-xs text-[#bbc9cf]">{config.description}</p>
          </div>
        </div>

        {/* Fingerprint */}
        {fingerprint && (
          <div>
            <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">
              {ATTESTATION_LABELS.FINGERPRINT}
            </span>
            <div className="flex items-center gap-2 mt-0.5">
              <code className="text-xs font-mono text-[#00d4ff] break-all">{fingerprint}</code>
              <button
                onClick={() => handleCopy(fingerprint, 'fp')}
                className="text-[#bbc9cf] hover:text-[#dce3ed] shrink-0"
                aria-label={ATTESTATION_LABELS.COPY_FINGERPRINT}
              >
                {copiedField === 'fp' ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>
        )}

        {/* Chain proof details */}
        {chainProof && (
          <>
            {/* Network Receipt */}
            <div>
              <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">
                {ATTESTATION_LABELS.NETWORK_RECEIPT}
              </span>
              <div className="flex items-center gap-2 mt-0.5">
                {chainProof.explorer_url && chainProof.explorer_url.startsWith('https://') ? (
                  <a
                    href={chainProof.explorer_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-mono text-[#00d4ff] hover:text-[#a8e8ff] flex items-center gap-1"
                  >
                    <ExternalLink className="h-3 w-3" />
                    {chainProof.tx_id.slice(0, 20)}...
                  </a>
                ) : (
                  <code className="text-xs font-mono text-[#bbc9cf]">
                    {chainProof.tx_id.slice(0, 20)}...
                  </code>
                )}
                <button
                  onClick={() => handleCopy(chainProof.tx_id, 'tx')}
                  className="text-[#bbc9cf] hover:text-[#dce3ed] shrink-0"
                  aria-label={ATTESTATION_LABELS.COPY_RECEIPT}
                >
                  {copiedField === 'tx' ? (
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </div>

            {/* Network Checkpoint */}
            {chainProof.block_height !== null && (
              <div>
                <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">
                  {ATTESTATION_LABELS.NETWORK_CHECKPOINT}
                </span>
                <p className="text-sm font-mono mt-0.5">
                  {chainProof.block_height.toLocaleString()}
                </p>
              </div>
            )}

            {/* Network Observed Time */}
            {chainProof.timestamp && (
              <div>
                <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">
                  {ATTESTATION_LABELS.NETWORK_OBSERVED_TIME}
                </span>
                <p className="text-xs text-[#bbc9cf] mt-0.5">
                  {formatDateTime(chainProof.timestamp)}
                </p>
              </div>
            )}
          </>
        )}

        {/* Pending message when no chain proof */}
        {!chainProof && (status === 'PENDING' || status === 'DRAFT') && (
          <div className="flex items-center gap-2 text-sm text-amber-400">
            <Clock className="h-4 w-4" />
            <span>{ATTESTATION_LABELS.VERIFICATION_PENDING_DESC}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
