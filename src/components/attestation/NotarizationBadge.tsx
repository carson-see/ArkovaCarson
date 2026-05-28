/**
 * Notarization Badge (SCRUM-1874)
 *
 * Visual indicator for attestations that have been notarized via DocuSign
 * or completed e-signature. Shows notary details and envelope information
 * from the legally_binding_attestations table.
 *
 * Renders nothing when no notarization or e-signature data is present.
 */

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Stamp, PenLine } from 'lucide-react';
import { ATTESTATION_LABELS } from '@/lib/copy';

interface NotarizationBadgeProps {
  /** ISO date string when notarization was completed */
  notarizationCompletedAt?: string | null;
  /** Name of the notary public */
  notaryName?: string | null;
  /** Notary commission number */
  notaryCommissionNumber?: string | null;
  /** Notary commission state */
  notaryCommissionState?: string | null;
  /** DocuSign envelope ID */
  docusignEnvelopeId?: string | null;
  /** ISO date string when DocuSign envelope was completed */
  docusignCompletedAt?: string | null;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function NotarizationBadge({
  notarizationCompletedAt,
  notaryName,
  notaryCommissionNumber,
  notaryCommissionState,
  docusignEnvelopeId,
  docusignCompletedAt,
}: NotarizationBadgeProps) {
  const hasNotarization = !!notarizationCompletedAt;
  const hasDocusign = !!docusignEnvelopeId && !!docusignCompletedAt;

  if (!hasNotarization && !hasDocusign) return null;

  return (
    <Card className="border-[#00d4ff]/10 bg-[#192028]" data-testid="notarization-badge">
      <CardContent className="py-4 space-y-4">
        {/* Notarization section */}
        {hasNotarization && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-sm bg-emerald-500/10 border border-emerald-500/20">
                <Stamp className="h-4 w-4 text-emerald-400" />
              </div>
              <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs gap-1">
                {ATTESTATION_LABELS.NOTARIZED}
              </Badge>
            </div>

            <div className="space-y-2 pl-10">
              {notaryName && (
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">
                    {ATTESTATION_LABELS.NOTARY_NAME}
                  </span>
                  <p className="text-sm mt-0.5">{notaryName}</p>
                </div>
              )}

              {notaryCommissionNumber && (
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">
                    {ATTESTATION_LABELS.NOTARY_COMMISSION}
                  </span>
                  <p className="text-sm font-mono mt-0.5">{notaryCommissionNumber}</p>
                </div>
              )}

              {notaryCommissionState && (
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">
                    {ATTESTATION_LABELS.NOTARY_STATE}
                  </span>
                  <p className="text-sm mt-0.5">{notaryCommissionState}</p>
                </div>
              )}

              {notarizationCompletedAt && (
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">
                    {ATTESTATION_LABELS.NOTARIZED_ON}
                  </span>
                  <p className="text-xs text-[#bbc9cf] mt-0.5">
                    {formatDateTime(notarizationCompletedAt)}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Separator between sections */}
        {hasNotarization && hasDocusign && (
          <Separator className="bg-[#bbc9cf]/10" />
        )}

        {/* E-signature section */}
        {hasDocusign && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-sm bg-blue-500/10 border border-blue-500/20">
                <PenLine className="h-4 w-4 text-blue-400" />
              </div>
              <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/20 text-xs gap-1">
                {ATTESTATION_LABELS.ESIGN_COMPLETED}
              </Badge>
            </div>

            <div className="space-y-2 pl-10">
              {docusignEnvelopeId && (
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">
                    {ATTESTATION_LABELS.ENVELOPE_ID}
                  </span>
                  <p className="text-sm font-mono text-[#00d4ff] mt-0.5">{docusignEnvelopeId}</p>
                </div>
              )}

              {docusignCompletedAt && (
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">
                    {ATTESTATION_LABELS.ESIGN_COMPLETED_ON}
                  </span>
                  <p className="text-xs text-[#bbc9cf] mt-0.5">
                    {formatDateTime(docusignCompletedAt)}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
