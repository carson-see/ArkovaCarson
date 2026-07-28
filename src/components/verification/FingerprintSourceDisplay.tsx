/**
 * Fingerprint Source Display (R19, CTO ruling 2026-07-28, advances SCRUM-2481)
 *
 * Renders the document-derived vs record-derived (issuer attestation)
 * evidence class on the public verification page, with the measured /
 * asserted / NOT-asserted triad per §1.5.
 *
 * HONESTY INVARIANT (R-7 claims gate): `issuer_record_attestation` copy must
 * NEVER state or imply that Arkova received, reviewed, or verified a source
 * document. Enforced by test.
 */

import { FileText, ClipboardList } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { FINGERPRINT_SOURCE_LABEL_HEADING, EVIDENCE_TRIAD_LABELS } from '@/lib/copy';
import {
  getFingerprintSourceLabel,
  getFingerprintSourceDescription,
  getFingerprintSourceTriad,
  parseFingerprintSource,
  type FingerprintSource,
} from '@/lib/fingerprintSource';

interface FingerprintSourceDisplayProps {
  value: FingerprintSource | string | null | undefined;
  className?: string;
}

const SOURCE_ICON: Record<FingerprintSource, React.ElementType> = {
  document_bytes: FileText,
  issuer_record_attestation: ClipboardList,
};

function getBadgeClasses(value: FingerprintSource): string {
  if (value === 'document_bytes') {
    return 'border-blue-500 text-blue-700 bg-blue-50 dark:bg-blue-950/20 dark:text-blue-400';
  }
  // issuer_record_attestation: deliberately NOT green/blue "verified"
  // treatment — a distinct neutral tier per R-7 (no document was received).
  return 'border-slate-400 text-slate-700 bg-slate-50 dark:bg-slate-900/40 dark:text-slate-300';
}

export function FingerprintSourceDisplay({
  value,
  className,
}: Readonly<FingerprintSourceDisplayProps>) {
  const tier = parseFingerprintSource(value);
  // Unclassified (NULL, pre-R19 anchors) renders nothing — never guessed (§1.5).
  if (!tier) return null;

  const label = getFingerprintSourceLabel(tier);
  const description = getFingerprintSourceDescription(tier);
  const triad = getFingerprintSourceTriad(tier);
  if (!label || !triad) return null;

  const Icon = SOURCE_ICON[tier];

  return (
    <div className={`space-y-2 ${className ?? ''}`} data-testid="fingerprint-source-display">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{FINGERPRINT_SOURCE_LABEL_HEADING}</span>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                className={`gap-1 text-xs ${getBadgeClasses(tier)}`}
                data-testid="fingerprint-source-badge"
                data-fingerprint-source={tier}
              >
                <Icon className="h-3 w-3" aria-hidden="true" />
                {label}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              <p className="text-xs">{description}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      <dl
        className="rounded-md border border-border/60 bg-muted/30 p-2 text-xs space-y-1"
        data-testid="fingerprint-source-triad"
        data-fingerprint-source={tier}
      >
        <div className="flex gap-1.5">
          <dt className="font-medium text-muted-foreground shrink-0">
            {EVIDENCE_TRIAD_LABELS.MEASURED}:
          </dt>
          <dd data-testid="fingerprint-source-triad-measured">{triad.measured}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="font-medium text-muted-foreground shrink-0">
            {EVIDENCE_TRIAD_LABELS.ASSERTED}:
          </dt>
          <dd data-testid="fingerprint-source-triad-asserted">{triad.asserted}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="font-medium text-amber-700 dark:text-amber-400 shrink-0">
            {EVIDENCE_TRIAD_LABELS.NOT_ASSERTED}:
          </dt>
          <dd data-testid="fingerprint-source-triad-not-asserted">{triad.notAsserted}</dd>
        </div>
      </dl>
    </div>
  );
}
